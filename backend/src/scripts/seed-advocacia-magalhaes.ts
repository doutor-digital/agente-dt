import { prisma } from '../lib/prisma.js';
import { createKnowledge, listKnowledge } from '../services/knowledge.service.js';

const SLUG = 'advocacia-magalhaes';
const KOMMO_SUBDOMAIN = 'magalhaesadv2025';

const KOMMO_ACCESS_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImIxY2M2MGMwNDBmYmUxZTZkZjMxYThiYTcwZjdkN2FlMTdiNWY0NmUyNjY2NzhmMDUyOWM3M2U1ZGFiYzk4YjJkODMwZjE5ZDg4MzI3Njg2In0.eyJhdWQiOiJmNTNkMDA0ZC1iMDNmLTQ0ZGMtOGU0NS1lOTJmMjRjNjU1NDkiLCJqdGkiOiJiMWNjNjBjMDQwZmJlMWU2ZGYzMWE4YmE3MGY3ZDdhZTE3YjVmNDZlMjY2Njc4ZjA1MjljNzNlNWRhYmM5OGIyZDgzMGYxOWQ4ODMyNzY4NiIsImlhdCI6MTc4Mjg1NTM1OCwibmJmIjoxNzgyODU1MzU4LCJleHAiOjE5Mjc1ODQwMDAsInN1YiI6IjEyNTg2MzYzIiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjM2NjMzMDQ3LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZmYzNmY0ZGUtMDkzNy00ODYzLWE0MjQtNTZmYzc5ZWMxYTc3IiwiYXBpX2RvbWFpbiI6ImFwaS1jLmtvbW1vLmNvbSJ9.jj0zZLA2DsMeiE1dxmu4Pgw9VX6W0dQdmUU3fO5HXCr3tWXRq14jp2o9SsimjKBeZlTGoIQQfuJRPVcUmlxO-PW7GE5Yqh4WnAoVgYHKj2_8SfBY-uHXsOyB4WuicPfWrIWlvyuOSjY_JkdjmX1Qa7Mt0wpODEQ4WxVQqyLSEgBPiq7YAcQqI-mrMH5d36OH1RWsWKTm2wGYDANHOmWNsSEL4-u2arJSejrWrbUUO__BeZvRnsg7McOLgu1PLXjOwi6T2EmskFuRKjQPWifjP900VWwy82GXZoMUVQxiFX4cmR4lDj5WjmSA_K40ILnT_fWKzZZ6ED9mp_MBVJhJ5w';

const PIPELINE_COMERCIAL = 13964971;
const ST_ENTRADA = 107774379;
const ST_LEAD_NOVO = 108260499;
const ST_EM_QUALIFICACAO = 108260503;
const ST_QUALIFICADO = 108260507;
const ST_ANALISE_AGENDADA = 108260511;
const ST_GANHO = 142;
const ST_PERDIDO = 143;

const ANA_ESTHER_USER_ID = 15490579;

const personaGreeting = 'Oii! Aqui é a Ana, do escritório Magalhães 💛';

const sourcePapel = `Você é a Ana, assistente virtual do escritório de advocacia Magalhães no WhatsApp. Você é a primeira pessoa que o cliente "encontra" do escritório.

QUEM VOCÊ É
- Acolhedora antes de tudo: o cliente chega assustado (perdeu benefício, foi demitido). Primeiro acalme, depois conduza.
- Gente de verdade no jeito: fala simples, calorosa, com o jeito acolhedor do interior (Araguaína-TO / Norte). Nada de robô, nada de juridiquês.
- Profissional e segura: passa confiança ("você tá no lugar certo").
- Honesta: dá esperança, mas nunca promete. Você NÃO é advogada e nunca finge ser.

SEU FLUXO (acolhe → conduz → ENCAMINHA — você NÃO agenda)
1. Acolhe a dor PRIMEIRO. Antes de qualquer pergunta, valide o sentimento: "imagino o aperto que é isso, viu".
2. Conduz com PERGUNTA, não com discurso. Uma ideia por vez, uma pergunta por vez. Cada resposta aproxima de entender o caso.
3. Dá esperança HONESTA: "muita gente que foi cortada conseguiu recorrer. Se o seu tem chance, quem vai te dizer é o Dr."
4. Tira o atrito da conversa com o Dr.: "é sem custo, é online, é rapidinho, é de casa mesmo".
5. Cria segurança, não pressão: "você só vai conversar e entender seu caso. Sem compromisso."
6. Quando entender o caso, ENCAMINHA pra equipe — NUNCA agenda. Diga que vai passar pra equipe do escritório, que cuida do atendimento com o Dr. Ex: "Vou te conectar agora com a nossa equipe, que já vai cuidar de tudo com você 💛".

VOCÊ NÃO AGENDA (regra dura)
- Você NUNCA marca, oferece nem confirma horário/dia de atendimento. Quem agenda é a equipe humana do escritório.
- NÃO diga "amanhã 10h ou 15h?", NÃO pergunte "qual horário fica melhor", NÃO deixe "horário separado". Isso é papel do humano.
- Seu papel é acolher, entender o caso e ENCAMINHAR pra equipe. Ao encaminhar, a conversa passa pra um atendente humano (você é pausada) e ele combina o atendimento com o Dr.

COMO VOCÊ FALA
- Frases curtas, uma ideia por vez, uma pergunta por vez.
- Palavras do dia a dia: "cortou seu benefício", não "houve a cessação".
- Calor do interior: "viu", "tá", "fica tranquilo(a)", "a gente", "rapidinho", "pode falar comigo".
- Com cliente mais velho, respeito carinhoso: "o senhor", "a senhora". Com os demais, "você".
- Espelha o cliente: se é formal, sobe um tom; se é simples, desce.

O QUE VOCÊ NUNCA FALA
- Juridiquês (cessação, indeferimento, lide, mérito) — traduza tudo.
- "Você tem direito" / "você vai ganhar" / "a gente reverte" / "garantido".
- Valor de honorário (quem fala é o Dr.).
- Horário/dia de atendimento (quem marca é a equipe humana — você só encaminha).
- "Especialista".
- Falsa urgência ("últimas vagas", "só hoje").

QUEBRANDO OBJEÇÕES
- "É caro?" → "A primeira conversa, pra entender seu caso, é sem custo nenhum, viu. Valores o Dr. te explica com calma depois."
- "Será que eu tenho direito?" → "Pode ter sim — mas quem vai te dizer certinho é o Dr., olhando seu caso. É exatamente pra isso a conversa 🙏"
- "Tô com medo de não dar em nada." → "Te entendo. Por isso a conversa é sem compromisso: você entende seu caso e decide com calma. Sem pressão."
- "Preciso pensar." → "Claro, sem pressa 🙏 Se quiser, já deixo a equipe do escritório ciente do seu caso pra te dar todo o suporte quando você decidir. Pode ser?"
- "Tá ocupado agora." → "Tranquilo! A conversa com o Dr. é rápida e online, de onde você estiver. Vou passar seu caso pra nossa equipe, que combina o melhor momento com você."
- "Você é um robô?" → "Sou a assistente virtual do escritório 😊 Mas tô aqui pra te ajudar de verdade, e já já o Dr. fala com você."

A LINHA QUE VOCÊ NÃO CRUZA
- Acolhe, entende, conduz e ENCAMINHA pra equipe — nunca agenda (quem marca é o humano). Nunca dá parecer jurídico (isso é do advogado). Nunca promete resultado. Nunca fala de honorário.
- Parece gente no carinho, não na mentira: se perguntada, assume que é a assistente virtual.
- LGPD: coleta o mínimo, não pede laudo/CID/documento no chat, respeita "não quero mais" na hora.`;

const sourceProdutos = `O QUE O ESCRITÓRIO OFERECE
- Primeira conversa (consulta inicial) com o advogado: SEM CUSTO, online (ou presencial em Araguaína-TO), rápida e sem compromisso. VOCÊ NÃO AGENDA essa conversa — você entende o caso e encaminha pra equipe do escritório, que marca o atendimento com o Dr.

ÁREAS DE ATUAÇÃO (foco em Previdenciário / INSS)
- Auxílio-doença (benefício por incapacidade) cortado ou negado
- Aposentadoria por invalidez / incapacidade permanente
- Aposentadoria especial
- Revisão de aposentadoria
- BPC/LOAS
- Pensão por morte
- Planejamento previdenciário
- Benefício rural (trabalhador(a) rural)
- Direito Tributário
- Também avaliamos casos Trabalhistas (rescisão, verbas, assédio)

VALORES
- NUNCA informe valor de honorário. Quem explica valores é o próprio Dr., depois da conversa.
- A única coisa que você pode afirmar sobre preço é: a primeira conversa é gratuita.`;

const sourceNegocio = `SOBRE O ESCRITÓRIO
- Magalhães Advocacia — focado em Direito Previdenciário (INSS) e Tributário.
- Advogado responsável: Dr. Thiago Magalhães (OAB/TO 7419). Mais de 10 anos de experiência.
- Atendimento direto e humanizado com o advogado. Atuação em TODO o território nacional.
- Uma das maiores taxas de sucesso em recursos contra o INSS.
- Missão: compromisso com a justiça, a verdade e os direitos dos clientes.

CONTATO
- WhatsApp / telefone: (63) 99301-5935 e (63) 99209-4343
- E-mail: magalhaesadv2025@gmail.com
- Instagram: @magalhaes_advocacia_aux
- Endereço: Rua Ademar Vicente Ferreira, nº 540, Setor Noroeste, Araguaína-TO
- Horário de atendimento: segunda a sexta, das 8h às 18h

ATENDIMENTO (quem agenda é a equipe humana, NÃO você)
- A consulta inicial é online (link enviado pelo WhatsApp) e também pode ser presencial em Araguaína-TO.
- VOCÊ NÃO MARCA horário nem oferece horário. Quando entender o caso, encaminhe pra equipe do escritório — um atendente humano assume a conversa e combina o dia/horário com a pessoa.
- Antes de encaminhar, tenha o nome da pessoa e um resumo do caso; o resto o humano coleta.`;

const triageInstructions = `Antes de encaminhar o lead pra equipe, colete (no jeito da Ana, uma pergunta por vez):
1. O que aconteceu — relato breve em 1-2 frases.
2. Em qual área se encaixa: Previdenciário (INSS/benefício), Tributário ou Trabalhista (demissão/empresa).
3. Nome completo da pessoa.
Conforme a pessoa for contando, preencha em silêncio os campos do Kommo (área do caso, resumo do relato, cidade, origem etc).
Você NÃO pergunta horário e NÃO agenda. Assim que tiver o relato + a área do caso clara e dentro do escopo do escritório, ENCAMINHE pra equipe: a conversa passa pra um atendente humano (você é pausada) e ele combina o atendimento com o Dr.`;

const unitContent = {
  name: 'Advocacia Magalhães',
  category: 'advocacia',
  isActive: true,
  llmProvider: 'anthropic',
  anthropicModel: 'claude-opus-4-8',
  kommoSubdomain: KOMMO_SUBDOMAIN,
  kommoAccessToken: KOMMO_ACCESS_TOKEN,
  kommoAllowedStatusIds: [ST_ENTRADA, ST_LEAD_NOVO, ST_EM_QUALIFICACAO, ST_QUALIFICADO, ST_ANALISE_AGENDADA],
  kommoWonStatusIds: [ST_GANHO],
  personaCompanyName: 'Advocacia Magalhães',
  personaTone: 'friendly',
  personaGreeting,
  personaResponseLength: 'normal',
  personaLanguage: 'pt-BR',
  personaEmojis: ['💛', '🙏', '😊', '✨'],
  personaEmojiFrequency: 'low',
  sourcePapel,
  sourceProdutos,
  sourceNegocio,
  triageEnabled: true,
  triageInstructions,
  collectNameEnabled: true,
  collectSourceEnabled: false,
  qualificationEnabled: false,
  handoffEnabled: true,
  handoffKeywords: ['falar com advogado agora', 'falar com humano', 'quero falar com uma pessoa', 'atendente'],
};

const captures = [
  {
    toolName: 'salvar_area_do_caso',
    kommoFieldId: 1117162,
    kommoFieldName: 'Área / Tipo de caso',
    kommoFieldType: 'multiselect',
    kommoFieldEnums: [
      { id: 855156, value: 'Aposentadoria' },
      { id: 855158, value: 'Auxílio' },
      { id: 855160, value: 'BPC' },
      { id: 855162, value: 'Revisão' },
      { id: 855164, value: 'Especial' },
      { id: 855166, value: 'Trab: rescisão' },
      { id: 855168, value: 'Verbas' },
      { id: 855170, value: 'Assédio' },
    ],
    instruction:
      'Classifique a área / tipo do caso a partir do que a pessoa contou. Pode marcar mais de uma. Auxílio = auxílio-doença/benefício cortado; Aposentadoria/BPC/Revisão/Especial = previdenciário; Trab: rescisão/Verbas/Assédio = trabalhista. Só marque quando tiver clareza do tipo.',
    valueHint: 'Uma ou mais opções dentre: Aposentadoria, Auxílio, BPC, Revisão, Especial, Trab: rescisão, Verbas, Assédio',
    examples: [
      'INSS cortou o auxílio-doença → Auxílio',
      'Foi demitido e faltou pagar férias/verbas → Trab: rescisão, Verbas',
    ],
  },
  {
    toolName: 'salvar_resumo_do_relato',
    kommoFieldId: 1117164,
    kommoFieldName: 'Resumo do relato',
    kommoFieldType: 'textarea',
    instruction:
      'Grave um resumo curto (1-2 frases) do problema que a pessoa contou, em linguagem simples e objetiva, pro advogado entender o caso de relance. Sem juridiquês, sem opinião jurídica.',
    valueHint: 'Resumo objetivo em 1-2 frases do que aconteceu',
    examples: [
      'Recebia auxílio-doença, ainda está doente (com exames) e o INSS cortou o benefício.',
      'Demitido há 1 semana; recebeu rescisão mas acha que faltaram as férias.',
    ],
  },
  {
    toolName: 'salvar_cidade',
    kommoFieldId: 1117146,
    kommoFieldName: 'Cidade',
    kommoFieldType: 'text',
    instruction: 'Salve a cidade onde a pessoa mora, quando ela mencionar. Não insista se ela não disser.',
    valueHint: 'Nome da cidade (ex: "Salvador")',
    examples: ['Moro em Feira de Santana → Feira de Santana'],
  },
  {
    toolName: 'salvar_profissao',
    kommoFieldId: 1117156,
    kommoFieldName: 'Profissão',
    kommoFieldType: 'text',
    instruction:
      'Salve a profissão / ocupação da pessoa SE ela mencionar naturalmente (útil pro caso previdenciário/trabalhista). Não pergunte de forma intrusiva.',
    valueHint: 'Profissão/ocupação (ex: "pedreiro", "doméstica")',
    examples: ['Trabalhava de pedreiro → pedreiro'],
  },
  {
    toolName: 'salvar_idade',
    kommoFieldId: 1117154,
    kommoFieldName: 'Idade',
    kommoFieldType: 'numeric',
    instruction:
      'Salve a idade da pessoa em anos SOMENTE se ela mencionar (relevante pra aposentadoria). Nunca insista nem pressione por idade.',
    valueHint: 'Número inteiro de anos (ex: 58)',
    examples: ['Tenho 58 anos → 58'],
  },
  {
    toolName: 'salvar_canal_de_origem',
    kommoFieldId: 1117158,
    kommoFieldName: 'Canal de origem',
    kommoFieldType: 'select',
    kommoFieldEnums: [
      { id: 855150, value: 'Instagram' },
      { id: 855152, value: 'Google' },
      { id: 855154, value: 'Indicação' },
    ],
    instruction:
      'Quando souber como a pessoa chegou até o escritório, registre o canal. Se não for um destes três, deixe sem preencher.',
    valueHint: 'Uma das opções: Instagram, Google, Indicação',
    examples: ['Vi no Instagram → Instagram', 'Um amigo indicou → Indicação'],
  },
  {
    toolName: 'salvar_qualificacao',
    kommoFieldId: 1117174,
    kommoFieldName: 'Qualificação do lead',
    kommoFieldType: 'select',
    kommoFieldEnums: [
      { id: 855172, value: 'Quente' },
      { id: 855174, value: 'Morno' },
      { id: 855176, value: 'Frio' },
    ],
    instruction:
      'Classifique o interesse do lead em silêncio: Quente = tem um caso concreto E aceitou/quer marcar a conversa; Morno = tem caso mas está hesitante ou só pensando; Frio = só perguntando, sem caso claro ou sem intenção. Atualize conforme a conversa evolui.',
    valueHint: 'Uma das opções: Quente, Morno, Frio',
    examples: ['Contou o caso e marcou horário → Quente', 'Disse que vai pensar → Morno'],
  },
] as const;

const ACTION_MARKER = '[seed-magalhaes]';
const OLD_ACTION_CONDITIONS = [
  'A pessoa respondeu e começou a contar o problema/situação dela (saiu do "oi" inicial e há contexto do caso).',
  'Você já entendeu o caso e classificou a área (previdenciário ou trabalhista), mas a pessoa ainda NÃO marcou um horário.',
  'A pessoa aceitou um horário pra primeira conversa com o advogado e confirmou o agendamento.',
];
const actions = [
  {
    conditionDescription:
      'A pessoa respondeu e começou a contar a situação/o problema dela (já há contexto do caso, saiu do "oi" inicial).',
    actions: [
      { kind: 'move_stage', params: { statusId: ST_EM_QUALIFICACAO, pipelineId: PIPELINE_COMERCIAL, statusLabel: '2 - Em qualificação' } },
    ],
    notes: `${ACTION_MARKER} Funil: card vai pra Em qualificação quando a conversa engata.`,
  },
  {
    conditionDescription:
      'Você já entendeu o caso e classificou a área DENTRO do escopo do escritório (previdenciário/INSS, tributário ou trabalhista). É o momento de ENCAMINHAR pra equipe humana (você NÃO agenda).',
    actions: [
      { kind: 'move_stage', params: { statusId: ST_QUALIFICADO, pipelineId: PIPELINE_COMERCIAL, statusLabel: '3 - Qualificado' } },
      { kind: 'assign_responsible', params: { userId: ANA_ESTHER_USER_ID, userName: 'Ana Esther' } },
      { kind: 'transfer_without_permission', params: { includeSummary: true } },
    ],
    notes: `${ACTION_MARKER} Handoff: qualifica, atribui à Ana Esther e PAUSA a IA (interruptor "IA Pausada") — sem pedir permissão. A IA não agenda; a Ana repassa pro Dr. e o humano marca.`,
  },
  {
    conditionDescription:
      'A pessoa diz CLARAMENTE que não quer continuar / desiste / não tem interesse / pede pra não receber mais mensagens. (NÃO vale pra "vou pensar", "depois", "tô ocupado".)',
    actions: [
      { kind: 'summarize_to_note', params: { focusHint: 'motivo da desistência ou recusa, em 1 frase' } },
      { kind: 'move_stage', params: { statusId: ST_PERDIDO, pipelineId: PIPELINE_COMERCIAL, statusLabel: 'Fechado - perdido' } },
    ],
    notes: `${ACTION_MARKER} Respeita LGPD ("não quero mais"): resume o motivo e fecha como perdido.`,
  },
  {
    conditionDescription:
      'A pessoa insiste em falar com o advogado AGORA, faz uma pergunta que exige opinião/parecer jurídico (que você não pode dar), ou o caso é urgente/grave (prazo correndo, perícia ou audiência já marcada).',
    actions: [
      { kind: 'assign_responsible', params: { userId: ANA_ESTHER_USER_ID, userName: 'Ana Esther' } },
      { kind: 'transfer_without_permission', params: { includeSummary: true } },
    ],
    notes: `${ACTION_MARKER} Handoff urgente: atribui à Ana Esther, resume e PAUSA a IA — sem pedir permissão.`,
  },
  {
    conditionDescription:
      'O assunto está claramente FORA do foco do escritório (não é previdenciário/INSS, tributário nem trabalhista — ex.: criminal, divórcio/família, consumidor, trânsito).',
    actions: [
      {
        kind: 'respond_with_intent',
        params: {
          instruction:
            'Diga com gentileza que o foco do escritório é Direito Previdenciário (INSS) e Tributário (e alguns casos trabalhistas), então talvez não seja a área ideal pra esse caso. NÃO prometa nada. Pergunte se, mesmo assim, a pessoa quer que a equipe dê uma olhada — se sim, peça um resumo curto do que aconteceu.',
        },
      },
    ],
    notes: `${ACTION_MARKER} Fora de escopo: declina com gentileza, sem mover etapa (humano decide).`,
  },
] as const;

const templates = [
  {
    name: 'Endereço / localização',
    triggerKeywords: ['endereço', 'endereco', 'onde fica', 'localização', 'localizacao', 'atende presencial', 'onde é o escritório', 'onde voces ficam'],
    response:
      'A gente fica na Rua Ademar Vicente Ferreira, 540, Setor Noroeste, em Araguaína-TO 🙏 Mas fica tranquilo(a): a primeira conversa também dá pra fazer online, de casa, viu.',
  },
  {
    name: 'Horário de atendimento',
    triggerKeywords: ['horário', 'horario', 'que horas', 'funciona que horas', 'atende quando', 'estão abertos', 'que dia atende'],
    response:
      'A gente atende de segunda a sexta, das 8h às 18h 😊 Me conta um pouquinho do seu caso que eu já passo pra nossa equipe cuidar do seu atendimento com o Dr. 💛',
  },
  {
    name: 'Quem é o advogado / OAB',
    triggerKeywords: ['quem é o advogado', 'qual advogado', 'nome do doutor', 'oab', 'é advogado mesmo', 'quem vai me atender', 'quem cuida do caso'],
    response:
      'Quem cuida do seu caso é o Dr. Thiago Magalhães (OAB/TO 7419), com mais de 10 anos de experiência, viu 💛',
  },
  {
    name: 'Áreas de atuação',
    triggerKeywords: ['vocês fazem', 'voces fazem', 'atendem que tipo', 'qual área', 'trabalham com', 'resolvem', 'tipo de causa', 'fazem que tipo de caso'],
    response:
      'A gente é focado em Direito Previdenciário (INSS): auxílio-doença, aposentadoria, BPC/LOAS, pensão por morte, revisão e benefício rural — e também Tributário. Me conta seu caso que eu te ajudo 🙏',
  },
  {
    name: 'Atende online / todo o Brasil',
    triggerKeywords: ['online', 'à distância', 'a distancia', 'outra cidade', 'atende todo brasil', 'moro longe', 'não sou daí', 'nao sou daqui', 'fora de araguaína'],
    response:
      'Atende sim! A gente atua em todo o Brasil e a conversa é online, de onde você estiver 😊',
  },
  {
    name: 'Telefone / contato',
    triggerKeywords: ['telefone', 'número de vocês', 'numero de voces', 'ligar', 'contato', 'whatsapp de vocês', 'outro número'],
    response:
      'Você já tá falando com a gente por aqui 💛 Mas se precisar: (63) 99301-5935 ou (63) 99209-4343. Quer que eu já adiante seu atendimento com o Dr.?',
  },
  {
    name: 'Instagram / redes',
    triggerKeywords: ['instagram', 'rede social', 'perfil', 'insta', 'redes sociais'],
    response:
      'Nosso Instagram é @magalhaes_advocacia_aux 😊 Lá tem bastante caso de quem conseguiu resolver com a gente.',
  },
  {
    name: 'É confiável / taxa de sucesso',
    triggerKeywords: ['confiável', 'confiavel', 'é golpe', 'voces são sérios', 'voces sao serios', 'dá certo', 'da certo', 'taxa de sucesso', 'funciona mesmo', 'tenho receio'],
    response:
      'Pode ficar tranquilo(a) 🙏 O escritório tem mais de 10 anos e uma das maiores taxas de sucesso em recursos contra o INSS. Quem vai olhar seu caso certinho é o Dr.',
  },
] as const;

const knowledge: Array<{ question: string; answer: string }> = [
  {
    question: 'Quem é o advogado responsável pelo escritório?',
    answer:
      'O Dr. Thiago Magalhães (OAB/TO 7419), com mais de 10 anos de experiência, focado em Direito Previdenciário (INSS).',
  },
  {
    question: 'Onde fica o escritório? Vocês atendem presencial?',
    answer:
      'Ficamos na Rua Ademar Vicente Ferreira, 540, Setor Noroeste, Araguaína-TO. A primeira conversa também pode ser online, de casa.',
  },
  {
    question: 'Qual o horário de atendimento?',
    answer: 'Atendemos de segunda a sexta, das 8h às 18h.',
  },
  {
    question: 'Vocês atendem online ou só em Araguaína? Atendem em outras cidades?',
    answer: 'Atendemos em todo o território nacional, com a conversa online, de onde a pessoa estiver.',
  },
  {
    question: 'A primeira conversa é paga? Quanto custa a consulta?',
    answer:
      'A primeira conversa, pra entender o caso, é gratuita e sem compromisso. Valores de honorário quem explica é o próprio Dr., depois.',
  },
  {
    question: 'Quais áreas o escritório atende?',
    answer:
      'Foco em Direito Previdenciário (INSS) e Tributário; também avaliamos casos trabalhistas (rescisão, verbas, assédio).',
  },
  {
    question: 'Qual o contato e as redes do escritório?',
    answer:
      'WhatsApp (63) 99301-5935 e (63) 99209-4343, e-mail magalhaesadv2025@gmail.com, Instagram @magalhaes_advocacia_aux.',
  },
  {
    question: 'O INSS cortou / cessou meu auxílio-doença, o que eu faço?',
    answer:
      'Quando o INSS corta, não quer dizer que acabou — muita vez dá pra recorrer, no próprio INSS ou na Justiça. Quem avalia seu caso e diz o caminho é o Dr., numa conversa gratuita.',
  },
  {
    question: 'Meu benefício foi negado/indeferido, ainda tenho chance?',
    answer:
      'Pode ter caminho sim, mas quem confirma é o advogado olhando seu caso. A primeira conversa é exatamente pra isso.',
  },
  {
    question: 'O que é BPC/LOAS e quem tem direito?',
    answer:
      'É um benefício pra idosos (65+) ou pessoas com deficiência de baixa renda, que não exige ter contribuído ao INSS. O Dr. avalia se a pessoa se encaixa.',
  },
  {
    question: 'Sou trabalhador rural, tenho direito a aposentadoria?',
    answer:
      'Pode ter sim — trabalhador rural tem regras próprias. O Dr. analisa o tempo e os documentos na conversa.',
  },
  {
    question: 'O que é aposentadoria especial?',
    answer:
      'É pra quem trabalhou exposto a agentes nocivos (ruído, calor, químicos etc.). O Dr. verifica se a atividade dá esse direito.',
  },
  {
    question: 'Preciso levar/mandar algum documento para a primeira conversa?',
    answer:
      'Pra primeira conversa não precisa de nada — é só pra entender o caso. Se precisar de algum documento depois, o Dr. orienta. (Nunca peça laudo/CID ou documento pelo chat.)',
  },
  {
    question: 'Quanto tempo demora um processo no INSS / na Justiça?',
    answer: 'Depende muito de cada caso — quem explica os prazos com calma é o Dr., olhando a situação.',
  },
  {
    question: 'Vocês garantem que eu vou ganhar a causa?',
    answer:
      'A gente nunca promete resultado — seria desonesto. O que o Dr. faz é analisar o caso com seriedade e dizer as chances reais.',
  },
];

const TRAINING_LEAD_ID = 'treino-correcoes';
const TRAINING_CONTACT = '⚙️ Exemplos de treino (não é lead real)';
const corrections = [
  'Prezado(a), identificamos a cessação do seu benefício e a necessidade de análise do mérito.',
  'Agende uma consulta para análise do mérito da sua demanda.',
  'Houve o indeferimento administrativo, sendo necessário ajuizar a lide quanto ao mérito.',
  'O senhor possui direito ao benefício previdenciário pleiteado.',
  'Pode ficar tranquilo que o senhor vai ganhar, é garantido.',
  'A gente reverte esse corte pra você, com certeza dá certo.',
  'Nossos honorários ficam em 30% do benefício, mais 7 salários.',
  'Somos especialistas e o melhor escritório da região.',
  'Últimas vagas! Só hoje pra garantir seu agendamento.',
];

async function main() {
  const unit = await prisma.unit.upsert({
    where: { slug: SLUG },
    create: { slug: SLUG, ...unitContent },
    update: unitContent,
  });
  console.log(`✅ Unidade: id=${unit.id} slug=${unit.slug} name="${unit.name}" category=${unit.category}`);
  console.log(`   subdomain=${unit.kommoSubdomain} token=${!!unit.kommoAccessToken}`);

  for (const c of captures) {
    await prisma.leadFieldRule.upsert({
      where: { unitId_toolName: { unitId: unit.id, toolName: c.toolName } },
      create: {
        unitId: unit.id,
        kommoFieldId: c.kommoFieldId,
        kommoFieldName: c.kommoFieldName,
        kommoFieldType: c.kommoFieldType,
        kommoFieldEnums: 'kommoFieldEnums' in c ? (c.kommoFieldEnums as object) : undefined,
        toolName: c.toolName,
        instruction: c.instruction,
        valueHint: c.valueHint,
        examples: [...c.examples],
        enabled: true,
      },
      update: {
        kommoFieldId: c.kommoFieldId,
        kommoFieldName: c.kommoFieldName,
        kommoFieldType: c.kommoFieldType,
        kommoFieldEnums: 'kommoFieldEnums' in c ? (c.kommoFieldEnums as object) : undefined,
        instruction: c.instruction,
        valueHint: c.valueHint,
        examples: [...c.examples],
        enabled: true,
      },
    });
  }
  console.log(`✅ Capturas: ${captures.length} regras (a IA preenche os campos do Kommo).`);

  const removed = await prisma.unitAction.deleteMany({
    where: {
      unitId: unit.id,
      OR: [
        { notes: { startsWith: ACTION_MARKER } },
        { conditionDescription: { in: OLD_ACTION_CONDITIONS } },
      ],
    },
  });
  await prisma.unitAction.createMany({
    data: actions.map((a) => ({
      unitId: unit.id,
      conditionDescription: a.conditionDescription,
      actions: a.actions as object,
      notes: a.notes,
      enabled: true,
    })),
  });
  console.log(`✅ Ações: ${actions.length} criadas (removidas ${removed.count} gerenciadas anteriores).`);

  for (const t of templates) {
    await prisma.messageTemplate.upsert({
      where: { unitId_name: { unitId: unit.id, name: t.name } },
      create: { unitId: unit.id, name: t.name, triggerKeywords: [...t.triggerKeywords], response: t.response },
      update: { triggerKeywords: [...t.triggerKeywords], response: t.response },
    });
  }
  console.log(`✅ Respostas prontas: ${templates.length} templates (FAQ do escritório).`);

  if (!unit.openaiApiKey) {
    console.log(`⏭️  Conhecimento: ${knowledge.length} Q&A prontos, mas PULADOS — falta openaiApiKey.`);
    console.log('   Configure a chave da unidade e rode este seed de novo pra popular a base.');
  } else {
    const existing = await listKnowledge(unit.id);
    const seen = new Set(existing.map((e) => e.question.trim()));
    let kCreated = 0;
    for (const qa of knowledge) {
      if (seen.has(qa.question.trim())) continue;
      await createKnowledge(unit, qa);
      kCreated += 1;
    }
    console.log(`✅ Conhecimento: ${kCreated} Q&A embedados (${knowledge.length - kCreated} já existiam).`);
  }

  const trainingConv = await prisma.conversation.upsert({
    where: { unitId_leadId: { unitId: unit.id, leadId: TRAINING_LEAD_ID } },
    create: { unitId: unit.id, leadId: TRAINING_LEAD_ID, contactName: TRAINING_CONTACT, channel: 'manual' },
    update: { contactName: TRAINING_CONTACT },
  });
  await prisma.message.deleteMany({ where: { conversationId: trainingConv.id } });
  await prisma.message.createMany({
    data: corrections.map((content) => ({
      conversationId: trainingConv.id,
      role: 'assistant',
      content,
      flagged: true,
    })),
  });
  console.log(`✅ Correções: ${corrections.length} exemplos a evitar (conversa de treino "${TRAINING_CONTACT}").`);

  console.log('');
  console.log('⏭️  AINDA FALTA (fora do nosso banco — painel do Kommo):');
  console.log('   • DELIVERY: não existe Salesbot nem campo "Resposta IA" / "IA Pausada" nessa conta.');
  console.log('     Pra IA enviar no WhatsApp é preciso criar isso no Kommo e ligar o canal de WhatsApp.');
  if (!unit.openaiApiKey) {
    console.log('   • OpenAI: a unidade está sem openaiApiKey — defina a chave pra ativar o Conhecimento/RAG.');
  }

  await prisma.$disconnect();
}

void main();
