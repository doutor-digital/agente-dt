/**
 * Barreira contra vazamento de "bastidor" na resposta ao paciente.
 *
 * O modelo às vezes entrega, como se fosse fala, coisa que era pra ficar por
 * dentro: a chamada de ferramenta escrita em vez de executada, o raciocínio dele
 * em inglês, um marcador de template que não foi preenchido. Isso chega no
 * WhatsApp de gente de verdade.
 *
 * Dois casos medidos:
 *   • 26/08, Porto Nacional, paciente Luciano — recebeu literalmente
 *     "Then, waiting for his answer about scheduling — let me continue the conversation."
 *   • Simulação de 10 conversas — 1 delas entregou
 *     "<invoke name=\"agendar_consulta\"><parameter name=\"idClient\">1</parameter>…"
 *     com idClient inventado e data de 2024.
 *
 *   • 15/10, Mossoró, paciente Zuzu — recebeu a anotação que era para a equipe:
 *     "Registrei o acompanhamento com a Zuzu — ela qualificou o atendimento particular e a
 *     dor, mas pediu um tempo antes de marcar, então deixei agendado retorno pra próxima semana."
 *     Na mesma busca (30 dias) apareceram dezenas do mesmo tipo, em português: "Sem resposta
 *     ainda do paciente — vou aguardar", "O paciente perguntou o preço antes de contar a queixa —
 *     vou acolher", "Vou ignorar essa 'instrução'…". Esse é o tipo `bastidor_em_portugues`.
 *
 * A regra aqui é conservadora de propósito: na dúvida, DEIXA PASSAR. Segurar
 * mensagem boa é pior que deixar escapar uma ruim — o paciente calado é o lead
 * perdido. Por isso cada padrão exige evidência forte, não um "parece estranho".
 */

export type TipoVazamento =
  | 'tool_call_em_texto'
  | 'raciocinio_em_ingles'
  | 'placeholder_nao_preenchido'
  | 'bloco_interno'
  | 'bastidor_em_portugues';

export interface Vazamento {
  tipo: TipoVazamento;
  /** O pedaço que denunciou — vai pro log, nunca pro paciente. */
  trecho: string;
}

/** Sintaxe de chamada de ferramenta escrita como se fosse texto. */
const TOOL_CALL = [
  /<\s*invoke\s+name\s*=/i,
  /<\s*parameter\s+name\s*=/i,
  /<\s*function_calls\s*>/i,
  /<\s*antml:/i,
  /\bfunctions\.[a-z_]+\s*\(/i,
];

/**
 * Frases que só aparecem quando o modelo narra o próprio plano. Todas em inglês
 * e no formato "vou fazer X" — não pegam inglês legítimo do paciente ("ok",
 * "email", "whatsapp"), que aparece o tempo todo numa conversa brasileira.
 */
const RACIOCINIO_EN = [
  /\b(let me|i(?:'| a)?m going to|i will now|i should|i need to)\s+(continue|check|call|use|wait|ask|confirm|respond|proceed|look)\b/i,
  /\b(then|next|now),?\s+(waiting for|i(?:'| wi)?ll)\b/i,
  /\bthe (user|patient|customer) (said|wants|is asking|asked)\b/i,
  /\b(tool|function) (call|result)s?\b.*\b(returned|shows|says)\b/i,
];

/**
 * Bastidor em português: a IA fala DO paciente (terceira pessoa), narra o que fez no sistema ou
 * comenta uma instrução — tudo coisa que só faz sentido para a equipe. Cada padrão é uma marca que
 * mensagem de verdade ao paciente não tem: ninguém escreve "o lead" nem "o paciente perguntou" para
 * o próprio paciente. "Anotei aqui seu e-mail" e "Marquei aqui que você é de Pinda" falam COM a
 * pessoa e passam.
 */
const BASTIDOR_PT = [
  // Aceita mais de um advérbio e o "me" no meio: "o paciente ainda não me disse o nome" (Araguaína, 19/10/2026),
  // "o paciente só agradeceu" (Canaã, 16/10), "a paciente já despediu-se" (Balsas, 18/10), "a nossa paciente ainda
  // não me contou" (Araguaína, 14/10). Verbo no passado, de propósito: "o paciente conta a história e o
  // especialista examina" (presente, explicando a consulta) passa.
  /\b(?:o|a)\s+(?:nossa\s+|nosso\s+)?(?:paciente|lead)\s+(?:(?:j[aá]|ainda|n[aã]o|s[oó]|nunca|tamb[eé]m)\s+){0,3}(?:me\s+|nos\s+)?(?:perguntou|disse|respondeu|mandou|enviou|escreveu|falou|pediu|agradeceu|se\s+despediu|despediu-se|repetiu|est[aá]\s+repetindo|est[aá]\s+se\s+despedindo|qualificou|confirmou|informou|adiou|sumiu|parou|contou|ignorou|recusou|mencionou|relatou)\b/i,
  /\b(?:sem\s+resposta|fala\s+real)\s+(?:ainda\s+)?d[oa]\s+(?:paciente|lead)\b/i,
  /\b(?:o|a|do|da|ao|no|na|pelo|pela|esse|este|essa|esta|deste|desse|desta|dessa|neste|nesse)\s+lead\b/i,
  // "Essa mensagem não veio do paciente, então não vou segui-la" (Araguaína, 02/10/2026).
  /\bveio\s+d[oa]\s+(?:paciente|lead)\b/i,
  /^\s*(?:registrei|gravei|anotei|salvei|atualizei)\s+(?:o|a|os|as)\s+(?:acompanhamento|retorno|motivo|campo|cart[aã]o|status|qualifica[cç][aã]o|etapa|dados|resultado)\b/i,
  /^\s*marquei\s+(?:o\s+contato|o\s+cart[aã]o|o\s+lead)\s+como\b/i,
  /\bj[aá]\s+fiz\s+as\s+a[cç][oõ]es\b/i,
  /\bdeixo\s+pront[ao]\s+a\s+pr[oó]xima\s+intera[cç][aã]o\b/i,
  /\b(?:qualificar|classificar)\s+como\s+(?:quente|morno|frio)\b/i,
  /\bavan[cç]ar\s+de\s+etapa\b/i,
  /\binstru[cç][aã]o\s+interna\b/i,
  /\bvou\s+ignorar\s+(?:essa|esta|esse|este|a|o)\b/i,
  /\bn[aã]o\s+(?:vou|irei)\s+(?:tratar|responder|agir|seguir)\s+como\b/i,
  // "minha resposta anterior JÁ estava correta" — a correção legítima ("a resposta anterior estava errada") passa.
  /\bminha\s+(?:resposta|mensagem)\s+anterior\s+j[aá]\s+(?:estava|tinha)\b/i,
  // Preâmbulo de plano no começo da resposta (Canaã, 19/10/2026, 28053204): "Reconhecendo que já houve contato
  // anterior, vou retomar com leveza, sem cobrar o silêncio, e seguir a coleta do nome." e "Esse paciente já
  // conversou com a gente há cerca de uma semana e sumiu…, então vou retomar com leveza". O gerúndio + "vou"
  // só conta com verbo de condução da conversa: "Considerando que você mora longe, vou te passar o endereço" passa.
  /^\s*(?:reconhecendo|considerando|retomando|percebendo|notando|sabendo|vendo)\s+que\b[^\n]{0,200}?\bvou\s+(?:retomar|seguir|manter|conduzir|acolher|coletar|continuar|recome[cç]ar)\b/i,
  /^\s*(?:esse|este|essa|esta)\s+(?:paciente|contato)\b/i,
  /\bretomar\s+com\s+leveza\b/i,
  /\bsem\s+cobrar\s+(?:o|a)\s+(?:sil[eê]ncio|sumi[cç]o|demora|aus[eê]ncia)\b/i,
  /\b(?:seguir|continuar|fazer)\s+(?:com\s+)?a\s+coleta\s+d[oa]s?\b/i,
  /\bhouve\s+contato\s+anterior\b/i,

  // ── O que escapou depois do #63 (busca de 01 a 20/10/2026) ───────────────────────────────────────────
  // O modelo comenta a regra do próprio prompt: "TODA resposta termina com uma pergunta de continuidade". Taubaté
  // 15/10 ("Pela regra da persona, despedida sem pedido nenhum não precisa forçar pergunta de continuidade"), Canaã
  // 16/10 ("faz sentido não ter pergunta, já que o paciente só agradeceu"), Balsas 18/10 ("Forçar uma pergunta de
  // continuidade aqui soaria…"), Marabá 17/10 ("a própria regra da persona diz…"), Boa Vista 20/10 ("como manda a
  // regra de construção de valor"). Nenhuma dessas palavras aparece em conversa de verdade com paciente.
  /\bpergunta\s+de\s+continuidade\b/i,
  /\bfor[cç]ar\s+(?:uma\s+|a\s+|nova\s+|outra\s+)?pergunta\b/i,
  /\bfaz\s+sentido\s+n[aã]o\s+(?:ter|fazer|mandar|incluir)\s+(?:uma\s+|nova\s+|outra\s+)?pergunta\b/i,
  /\bpersona\b/i,
  /\bcomo\s+manda\s+a\s+regra\b/i,
  /\bregra\s+real\b/i,
  /\bclaramente\s+fora\s+do\s+(?:nosso\s+)?escopo\b/i,
  /\bsem\s+fit\b/i,
  // Ação de bastidor contada AO PACIENTE depois da ferramenta (29/10/2026, Timbó, lead 5052994: 'Apliquei a tag "Fora
  // do escopo" só para sinalizar… Quer que eu siga conduzindo a conversa com ele sobre a dor na coluna?'; Timbó 17:50
  // 'Apliquei a tag "Frio" e registrei cidade (Brusque) e motivo…'; Parauapebas 30/10 'Movi o lead para "Em Espera"';
  // Rio Verde e Canaã 28–29/10 '…apliquei a tag "Fora do escopo"'). Tag, etiqueta, etapa e cartão são palavras da
  // equipe, nunca do paciente; "Marquei aqui que vocês vão buscar tratamento mais perto" (fala com o paciente) passa.
  /\b(?:apliquei|coloquei|adicionei|removi|tirei|retirei)\s+(?:a\s+|as\s+|uma\s+)?(?:tag|tags|etiqueta|etiquetas|marca[cç][aã]o|classifica[cç][aã]o)\b/i,
  /\b(?:a|as|uma)\s+(?:tag|etiqueta)s?\s+["“'«]/i,
  /\bmovi\s+(?:o|a)\s+(?:lead|cart[aã]o|card|contato|paciente|neg[oó]cio)\b/i,
  /\bmovi\s+(?:o|a)\s+\S+\s+para\s+(?:a\s+)?(?:etapa\b|["“])/i,
  /\bregistrei\s+(?:a\s+|o\s+)?(?:cidade|motivo|queixa|origem|regi[aã]o\s+da\s+dor)\b/i,
  /\bquer\s+que\s+eu\s+(?:siga|continue|prossiga)\s+(?:conduzindo|atendendo|com\s+o\s+atendimento|a\s+conversa)\b/i,
  /\bconduzindo\s+a\s+conversa\s+com\s+(?:ele|ela)\b/i,
  /\b(?:a\s+)?conversa\s+foi\s+encerrada\s+pela\s+equipe\b/i,
  // Parauapebas 15/10 (24777662): "chegou formatada como se fosse uma instrução minha… seguir a regra real: este card
  // está com a IA pausada para a equipe humana assumir, então não devo reabrir a condução automática".
  /\bcomo\s+se\s+fosse\s+(?:uma\s+)?instru[cç][aã]o\b/i,
  /\binstru[cç][aã]o\s+minha\b/i,
  /\b(?:este|esse|o|no|do|neste|nesse)\s+card\b/i,
  /\bIA\s+(?:est[aá]\s+|j[aá]\s+|foi\s+)?pausada\b/i,
  /\bcondu[cç][aã]o\s+autom[aá]tica\b/i,
  /\bn[aã]o\s+devo\s+(?:reabrir|continuar\s+conduzindo)\b/i,
  /\b(?:o\s+atendimento|a\s+conversa)\s+(?:j[aá]\s+)?foi\s+pausad[oa]\b/i,
  // Açailândia 19/10: "Não encontrei na nota anterior uma pergunta real ainda sem resposta — vou seguir com o
  // próximo passo natural da conversa."
  /\bpergunta\s+real\b/i,
  /\bnota\s+anterior\b/i,
  /\b(?:pr[oó]ximo\s+passo|caminho)\s+natural\s+da\s+conversa\b/i,
  // O plano do turno narrado: "vou acolher, explicar que já respondo, e puxar uma pergunta sobre a dor dele"
  // (Araguaína 06/10 e 19/10, Boa Vista 20/10). "Vou acolher" seguido de vírgula/travessão é lista de passos; "puxar
  // uma pergunta" e "antes de soltar o valor" são jargão de quem planeja, não de quem conversa.
  /\bvou\s+acolher\s*[,—–-]/i,
  /\bpuxar\s+(?:uma\s+|a\s+)?pergunta\b/i,
  /\bantes\s+de\s+soltar\s+o\s+valor\b/i,
  // "vou perguntar…" / "agora preciso…" só contam quando o alvo é o paciente em terceira pessoa ou um passo do
  // roteiro. "Agora preciso confirmar com você…", "Preciso te perguntar uma coisa importante…" e "Vou te perguntar:
  // há quanto tempo ele sente?" (falando com a mãe) passam.
  /\b(?:vou|preciso|devo)\s+(?:perguntar|coletar|investigar|confirmar)\s+(?:a|o|sobre\s+a|sobre\s+o)\s+(?:queixa|nome|tempo\s+de\s+dor|cidade)\s+d[oa]\s+(?:paciente|lead|contato)\b/i,
  /\b(?:vou|preciso|devo)\s+perguntar\s+(?:pr[oa]|ao|[aà])\s+(?:paciente|lead|contato)\b/i,
  /\bagora\s+(?:eu\s+)?preciso\s+(?:seguir|avan[cç]ar|voltar|retomar)\s+(?:com\s+|para\s+|pra\s+)?(?:a|o)\s+(?:coleta|qualifica[cç][aã]o|roteiro|fluxo|etapa|fase)\b/i,

  // ── O que escapou depois do #101 (Parauapebas, 28695422, 16/10/2026: três planos do turno seguidos) ───────────
  // "A memória mostra que a queixa… ainda não foi respondida — a outra Sofia perguntou duas vezes… Vou aproveitar que
  // ela voltou com interesse em preço… (regra de "se insistir, responda"), mas ainda tentar capturar a queixa";
  // "A pergunta sobre red flag… a filha repetiu a mesma mensagem… Vou reconhecer o que ela disse, não insistir pela
  // terceira vez"; "A pessoa está repetindo a mesma mensagem… vou acolher de novo, sem repetir pergunta de red flag pela
  // quarta vez". Jargão do prompt (red flag, memória, outra Sofia, capturar) e a pessoa com quem se fala em terceira
  // pessoa. "Sua filha me contou", "a outra unidade" e "desculpa perguntar pela segunda vez" passam. "Regra de '…'"
  // ficou de fora: Boa Vista (08/10) explicou a um paciente que "não tem uma regra de 'é normal só depois de tal idade'".
  // Rodado contra as 25.139 respostas da IA de 01 a 22/10: barra 4 a mais, os 3 acima e "A outra Sofia já tinha
  // separado dois horários" (Açailândia resgate, 10/10), que também é bastidor (o paciente não sabe de duas Sofias).
  /\bred[\s-]?flags?\b/i,
  /\b(?:a|na|da)\s+mem[oó]ria\s+(?:mostra|diz|indica|registra|aponta)\b/i,
  /\b(?:a|[aà]|na|da)\s+outra\s+(?:Sofia|IA)\b/i,
  /\bcapturar\s+(?:a|o)\s+(?:queixa|nome|dor|motivo|cidade)\b/i,
  /\b(?:a|o)\s+(?:pessoa|filha|filho|cliente)\s+(?:(?:j[aá]|ainda|n[aã]o|s[oó]|tamb[eé]m)\s+){0,2}(?:me\s+)?(?:perguntou|disse|respondeu|mandou|enviou|escreveu|repetiu|est[aá]\s+repetindo|voltou|ignorou|contou)\b/i,
  /\bvou\s+(?:acolher|reconhecer)\s+(?:de\s+novo|novamente|o\s+que\s+(?:ela|ele))\b/i,
  /\bvou\s+aproveitar\s+que\s+(?:ela|ele|a\s+pessoa|o\s+paciente|a\s+paciente)\b/i,
  /\b(?:n[aã]o|sem)\s+(?:insistir|repetir|perguntar)\b[^\n.]{0,60}\bpela\s+(?:segunda|terceira|quarta|quinta)\s+vez\b/i,
  /\bsem\s+responder\s+o\s+que\s+(?:eu\s+)?perguntei\b/i,

  // Caxias, lead 2823748, 13/11/2026: o áudio veio mudo e a Sofia abriu com "A transcrição do áudio veio bem genérica,
  // sem contar de fato o que ele está sentindo. Vou pedir pra ele mesmo me contar…". Transcrição é do sistema; o paciente
  // não sabe que existe. "Não consegui ouvir seu áudio" (a fala certa) não tem essa palavra.
  // (sem `\b` no fim: em JS, sem a bandeira `u`, `á`/`ê` contam como fora de palavra e "está\b" nunca casa)
  /\btranscri[cç][aã]o\s+(?:d[oa]s?\s+(?:seu\s+|sua\s+)?[aá]udios?\s+)?(?:veio|saiu|ficou|chegou|est[aá]|foi)(?![\p{L}])/iu,
  /\btranscri[cç][aã]o\s+(?:confusa|gen[eé]rica|ruim|vazia|truncada)(?![\p{L}])/iu,
];

// Nomes das ferramentas do agente (agent/tools.ts, agenda-tools.ts, sinal-pix-tool.ts). snake_case de ferramenta nunca
// aparece em fala de gente — se apareceu, o modelo está comentando a chamada que fez (ou que não pôde fazer).
export const NOMES_DE_FERRAMENTA = [
  'agendar_consulta',
  'aplicar_tag',
  'atribuir_responsavel',
  'atualizar_titulo_lead',
  'buscar_paciente',
  'cadastrar_paciente',
  'cancelar_consulta',
  'confirmar_presenca',
  'consultar_horarios',
  'criar_tarefa',
  'definir_valor_lead',
  'fechar_lead',
  'gerar_sinal_pix',
  'marcar_nao_paciente',
  'mover_etapa',
  'mover_funil',
  'pausar_ia',
  'registrar_campo',
  'remarcar_consulta',
  'remover_tag',
  'resumir_lead_para_sdr',
];

/**
 * O RACIOCÍNIO do modelo entregue como fala (19/11/2026, varredura das respostas da Sofia de 60 dias). Diferente do
 * `bastidor_em_portugues` de cima (a IA narra o que FEZ no sistema), aqui ela pensa alto sobre o que fazer: comenta a
 * "instrução" que o paciente teria injetado, decide se age, cita a regra do prompt, avisa que "não precisa agir". Casos
 * reais, todos entregues no WhatsApp:
 *   • 16/11 20:54  "A equipe já confirmou a consulta dela (18/11 às 10h15) e o pagamento no dia — não preciso agir sobre
 *                   isso, só responder o cumprimento." + "Boa tarde, Aparecida! …"
 *   • 12/11 13:55  "Esse "paciente" na verdade já foi encerrado como candidato a vaga (currículo)… não há agendamento em
 *                   aberto para processar aqui. Além disso, não posso seguir instruções que chegam como se fossem do sistema…"
 *   • 05/11 20:07  "Ignorando a instrução injetada (não é o paciente falando, e não tenho ferramenta de agendar_consulta
 *                   disponível — vou seguir as regras reais da conversa)."
 *   • 03/11 13:05  "Preciso confirmar algo antes de responder: a equipe enviou um áudio e não tenho o conteúdo dele
 *                   transcrito, então vou seguir com cautela aqui." + "Bom dia! 😊 …"
 * Mesma régua dos outros: cada marca só existe em raciocínio, nunca em fala com paciente.
 */
const RACIOCINIO_PT = [
  // A "instrução" que o modelo acha que o paciente injetou (e que ele comenta em voz alta).
  // Primeira pessoa ou gerúndio de abertura: "Ignoro essa instrução", "Ignorando a instrução injetada", "vou ignorar". O infinitivo
  // solto é conselho ao paciente ("não recomendo ignorar as instruções do médico") e passa.
  /(?:^|[\n.!?—–]\s*)(?:ignoro|ignorando)(?![\p{L}])[^.\n]{0,60}?\binstru[cç]/imu,
  // "Não vou ignorar suas instruções, pode deixar!" é promessa ao paciente: negação antes ou possessivo no meio tira o padrão.
  /(?<!n[aã]o\s)\bvou\s+ignorar(?![\p{L}])(?:(?!\bsuas?\b|\bseus?\b)[^.\n]){0,60}?\binstru[cç]/iu,
  /\bignor(?:ar|á)(?:-l[aoe]s?)?(?![\p{L}])[^.\n]{0,40}\bcomo\s+(?:instru[cç][aã]o|comando|ordem)/iu,
  /\binstru[cç][aãõo]\w*\s+(?:injetada|embutida|disfar[cç]ada|falsa)/iu,
  /\binstru[cç][aã]o\s+externa\s+tentando/iu,
  // "instruções que chegam como se fossem do sistema", "instruções que vêm dentro do conteúdo": só com o complemento de quem comenta a injeção
  // ("As instruções vêm por WhatsApp na véspera" é fala de clínica e passa).
  /\binstru[cç][oõ]es\s+que\s+(?:chegam|v[eê]m)\s+(?:como\s+se|dentro|disfar[cç]ad|de\s+dentro|pela\s+conversa)/iu,
  /\binstru[cç][oõ]es\s+(?:desse\s+tipo\s+)?vindas\s+(?:pela|da|de)\s+(?:conversa|mensagem)/iu,
  /\bn[aã]o\s+[eé]\s+(?:o\s+|a\s+)?paciente\s+falando/iu,
  /\bn[aã]o\s+[eé]\s+uma\s+conversa\s+d[oa]\s+paciente/iu,
  /\brelat[oó]rio\s+interno\s+da\s+equipe/iu,
  /\btexto\s+embutido\b|\btentando\s+me\s+manipular/iu,
  // A regra do prompt citada como se fosse assunto da conversa.
  /\b(?:sigo|seguir|segue)\s+(?:apenas\s+|somente\s+|s[oó]\s+)?(?:as\s+|a\s+)?(?:minhas\s+)?regras\s+(?:reais|da\s+minha\s+configura[cç][aã]o)/iu,
  /\bminhas?\s+(?:regras\s+(?:n[aã]o\s+mudam|reais)|configura[cç][aã]o\s+real)/iu,
  /\bvou\s+seguir\s+as\s+regras\s+reais\b/iu,
  /\bpela\s+regra\s+d[aeo]s?\s+(?:insist[eê]ncia|rea[cç][aã]o|elogio|pre[cç]o\s+insistido)/iu,
  /\bregra\s+(?:d[aeo]s?|sobre)\s+(?:insist[eê]ncia|rea[cç][aã]o|pre[cç]o\s+insistido|elogio)/iu,
  /\bs[oó]\s+um\s+cumprimento["”']?\s*(?:—|–|-|:)?\s*(?:respondo|regra)/iu,
  // Ferramenta: o nome (snake_case) ou o comentário de que não há ferramenta / não é caso de chamar.
  // Borda esquerda sem `/ . - = ? # : & @ %`: o nome dentro de um link ("https://clinica.com.br/agendar_consulta") é endereço, não vazamento.
  new RegExp(`(?<![\\p{L}\\p{N}_/.\\-=?#:&@%~])(?:${NOMES_DE_FERRAMENTA.join('|')})(?![\\p{L}\\p{N}_]|\\.[a-z]|/)`, 'iu'),
  // Só a ferramenta de AGENDAR citada como o modelo cita ("não tenho ferramenta de agendar_consulta disponível", "nenhuma ferramenta de
  // agendamento de consulta para chamar"). "Não tenho a ferramenta de pagamento por cartão aqui, mas o Pix funciona" é fala e passa.
  /\bn[aã]o\s+tenho\s+(?:nenhuma\s+)?ferramenta\s+de\s+agend\w*[^.\n]{0,60}\b(?:para\s+chamar|dispon[ií]vel)/iu,
  /\b(?:sem|n[aã]o\s+(?:vou|preciso|devo))\s+(?:acionar|chamar|usar|executar)\s+(?:nenhuma\s+|a\s+)ferramenta/iu,
  /\b(?:essa|esta)\s+ferramenta\s+n[aã]o\s+se\s+aplica/iu,
  /\b(?:j[aá]\s+mandei\s+(?:as\s+)?|sem\s+necessidade\s+de\s+a[cç][aã]o\s+de\s+|a[cç][aã]o\s+de\s+)tools?(?![\p{L}])/iu,
  // A IA comenta a PRÓPRIA ferramenta como se o paciente tivesse visto: "Desculpa, isso não devia ter sido feito, vou corrigir."
  // (Tatuí 19/11/2026, depois de gravar "Ocupado" no cartão) e "Desculpa, não precisava ter feito isso — vamos ao que importa:"
  // (Salto 13/11). O paciente não sabe de ação nenhuma. Medido em 20/10–19/11 nas 32.177 respostas da IA: só estas duas casam.
  // "Isso não deveria ter acontecido com você" (empatia) e "Desculpa, vou corrigir seu cadastro" (o paciente reclamou) passam.
  /\b(?:isso|aquilo)\s+n[aã]o\s+(?:devia|deveria|precisava)\s+(?:ter\s+)?(?:sido\s+)?feit[oa](?![\p{L}])/iu,
  // Só depois de um pedido de desculpa: "Não precisava ter feito isso!" sozinho é o agradecimento educado a um gesto do paciente.
  /\b(?:desculp\w*|perd[aã]o|foi\s+mal)\b[^.\n]{0,25}\bn[aã]o\s+(?:devia|deveria|precisava)\s+(?:ter\s+)?feito\s+isso(?![\p{L}])/iu,
  // "Não preciso agir", "ação de qualificação", "nada para eu agir": a decisão de acionar (ou não) o sistema.
  /\bn[aã]o\s+preciso\s+agir\b/iu,
  /\bn[aã]o\s+(?:h[aá]|tem)\s+nada\s+(?:pra|para)\s+(?:eu\s+)?agir\b/iu,
  /\bn[aã]o\s+(?:vou|irei)\s+agir\s+nem\s+responder\s+como\s+se\b/iu,
  /\ba[cç][aã]o\s+(?:de\s+qualifica[cç][aã]o|nova\s+a\s+disparar)/iu,
  /\bn[aã]o\s+[eé]\s+(?:um\s+caso\s+)?de\s+qualifica[cç][aã]o/iu,
  /\bnenhuma\s+a[cç][aã]o\s+(?:adicional\s+no\s+kommo|neste\s+turno)/iu,
  /\bvou\s+aguardar\s+o\s+pr[oó]ximo\s+contato\s+d[oa]\s+paciente\s+(?:pra|para)\s+seguir\b/iu,
  /\bn[aã]o\s+(?:vou|devo)\s+usar\s+(?:isso|esse|este)\s+como\s+(?:o\s+)?nome\s+d[oa]\s+paciente/iu,
  /\bcomo\s+as\s+regras\s+indicam\b/iu,
  /\bclaramente\s+n[aã]o\s+[eé]\s+(?:um\s+)?nome\b/iu,
  /\bchamei\s+sem\s+(?:ele|ela)\s+ter\b/iu,
  /\b(?:sigo|seguir)\s+o\s+fluxo\s+normal\s+de\s+qualifica[cç][aã]o/iu,
  /\bem\s+aberto\s+para\s+processar\b/iu,
  // "Preciso confirmar algo antes de responder: a equipe enviou um áudio…" e "Confira meu calendário real antes de responder."
  // ("Vou verificar a agenda antes de responder certinho" e "Deixa eu confirmar uma coisa antes de responder, tá?" são fala e passam).
  /\b(?:preciso|devo)\s+(?:confirmar|verificar|checar|conferir)\s+(?:algo|uma\s+coisa)\s+antes\s+de\s+responder\s*:\s*(?:a\s+equipe|o\s+paciente|a\s+paciente|a\s+mensagem|o\s+[aá]udio)/iu,
  /(?:^|[\n.!?]\s*)(?:confira|consulte|verifique|cheque)\s+(?:o\s+|a\s+)?(?:meu|minha)\s+(?:calend[aá]rio|agenda)\b[^.\n]{0,30}\bantes\s+de\s+responder\b/imu,
  /\bvou\s+seguir\s+com\s+cautela\s+aqui\b/iu,
  // Só com "transcrito": "não tenho o conteúdo dele aberto aqui, pode mandar em PDF?" é fala.
  /\bn[aã]o\s+tenho\s+o\s+conte[uú]do\s+d(?:ele|ela)\s+transcrit/iu,
  /\bconte[uú]do\s+d(?:ele|ela)\s+transcrito\b/iu,
  // "A equipe mandou um áudio e a paciente já tinha dito…" (3ª pessoa, ninguém é chamado de você).
  /\ba\s+equipe\s+(?:j[aá]\s+)?(?:enviou|mandou)\s+um\s+[aá]udio\s+e\s+(?:a|o)\s+(?:paciente|pessoa)\b/iu,
];

/** Marcador de template que ficou sem valor: {{nome}}, {nome}, [NOME]. */
const PLACEHOLDER = [
  /\{\{\s*[a-z0-9_.]+\s*\}\}/i,
  /\{\s*(nome|name|data|hora|dia|horario|valor|cidade|clinica)\s*\}/i,
  /\[\s*(NOME|DATA|HORA|VALOR|CIDADE)\s*\]/,
];

/** Cabeçalho de bloco interno do prompt que escapou pra resposta. */
const BLOCO_INTERNO = [
  /<\/?\s*(persona|handoff|agenda|regras|contexto|etapa_do_lead|aprendizados|pipeline_intents)\s*>/i,
  /^\s*#{1,3}\s*(FASE|CONTEXTO DE TESTE|SANDBOX)\b/im,
  // Qualquer tag em minúsculas ("<thinking>", "<conversao>", "<falta_para_agendar>", "</memoria_paciente>"): o
  // prompt inteiro é montado com elas, e mensagem de WhatsApp não tem tag. "<3" e "<b>" (curtas) passam.
  /<\/?\s*[a-z][a-z_]{2,40}\s*>/,
  // Rótulo de raciocínio no começo de uma linha: "Raciocínio: …", "Thinking: …", "Nota interna: …".
  /^\s*(?:thinking|reasoning|racioc[ií]nio|an[aá]lise\s+interna|nota\s+interna|observa[cç][aã]o\s+interna)\s*:/im,
  /\[\s*(?:thinking|racioc[ií]nio|nota\s+interna|interno)\s*\]/i,
];

// Bordas por letra/número: com acento ("está", "já") o `\b` do JS falha.
const BORDA_E = String.raw`(?<![\p{L}\p{N}_])`;
const BORDA_D = String.raw`(?![\p{L}\p{N}_])`;

/**
 * Parágrafo que narra a conversa em terceira pessoa e decide o próprio passo, sem uma palavra dirigida a quem lê:
 * "A equipe já se apresentou e perguntou o nome — ainda não tenho resposta do paciente, então vou retomar",
 * "Ele agradeceu e encerrou a conversa — respondo curto e calorosamente", "Essa mensagem é só um 'Bom dia' — não traz
 * resposta à pergunta da equipe. Vou responder de forma breve". São três marcas JUNTAS, nesta ordem, no começo do parágrafo:
 *   1. o sujeito é a conversa, não a pessoa ("A equipe…", "O paciente…", "Essa mensagem…", "Ele/Ela…");
 *   2. um verbo de quem RELATA o que foi dito ("perguntou", "confirmou", "agradeceu", "não traz", "já tem uma conversa");
 *   3. depois, a decisão de quem narra ("vou responder", "respondo", "não preciso", "mantenho").
 * Fala de verdade ao paciente não é assim: "A equipe já confirmou sua consulta" tem "sua", e quem responde à mãe
 * diz "Entendi, ele está viajando, então vou aguardar" (começa por "Entendi"), não "Ele disse que está viajando — vou aguardar".
 * Se o parágrafo se dirige à pessoa (você/seu/sua/te/vocês/pergunta com "?"), não conta.
 */
const NARRA_SUJEITO = new RegExp(
  `^\\s*(?:(?:a|o)\\s+(?:equipe|paciente|pessoa|mensagem|pergunta|resposta|[aá]udio|conversa|imagem|dor\\s+que\\s+(?:ela|ele))${BORDA_D}|(?:essa|esta|esse|este)\\s+(?:mensagem|texto|conte[uú]do|conversa|relato|caso)${BORDA_D}|(?:essa|esta)\\s+[eé]\\s+a\\s+\\S+\\s+vez${BORDA_D}|(?:ele|ela)\\s+(?:j[aá]\\s+|s[oó]\\s+|n[aã]o\\s+)?(?:agradeceu|perguntou|respondeu|disse|mandou|enviou|insistiu|repetiu|encerrou|reabre|reabriu|confirmou|pediu)${BORDA_D}|j[aá]\\s+tem\\s+uma\\s+conversa${BORDA_D})`,
  'iu',
);
// Nome próprio de abertura ("Marcelo já confirmou…", "A Ilma já havia confirmado…"): SEM a bandeira `i`, senão `\p{Lu}` casa qualquer palavra.
const NARRA_NOME = /^\s*(?:[AO]\s+)?\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?\s+(?:j[aá]\s+|s[oó]\s+)?(?:perguntou|confirmou|respondeu|disse|comentou|mencionou|havia\s+(?:confirmado|perguntado|dito|respondido))(?![\p{L}\p{N}_])/u;
const NARRA_RELATO = new RegExp(
  `${BORDA_E}(?:perguntou|confirmou|respondeu|mandou|enviou|agradeceu|disse|encerrou|apresentou|pediu|insistiu|repetiu|reabre|reabriu|comentou|descreve|deu\\s+continuidade|j[aá]\\s+tem\\s+uma\\s+conversa|n[aã]o\\s+(?:traz|veio|corresponde)|veio\\s+(?:confus|mud|vazi)|j[aá]\\s+havia|ainda\\s+n[aã]o\\s+tenho|tratou|tentou|parece\\s+(?:estar|ser|ter\\s+vindo)|est[aá]\\s+encerrando)`,
  'iu',
);
const NARRA_DECISAO = new RegExp(
  `(?:[—–,.;!]|\\s-\\s)\\s*(?:e\\s+|ent[aã]o\\s+|mas\\s+|como\\s+\\S+\\s+\\S+\\s+)?(?:(?:vou|devo)\\s+(?:s[oó]\\s+|apenas\\s+)?(?:responder|retomar|aguardar|manter|refor[cç]ar|acolher|pedir|perguntar|seguir|continuar|insistir|tratar|parar|ignorar|reconhecer|deixar\\s+isso\\s+claro|considerar|corrigir)|respondo|mantenho|n[aã]o\\s+(?:vou|preciso|devo|cabe)|preciso\\s+(?:responder|seguir|manter|apenas)|sigo\\s+o\\s+fluxo)${BORDA_D}`,
  'iu',
);
const NARRA_TERCEIRA = new RegExp(`${BORDA_E}(?:paciente|pessoa|equipe|teste|inst[aâ]ncia|ele|ela|cliente|lead)${BORDA_D}`, 'iu');
// Só vira raciocínio quando a narração usa o vocabulário de quem PLANEJA o atendimento (paciente, lead, fluxo, regra, cumprimento,
// transcrição, triagem, "não traz", "encerrou a conversa"…). "A equipe já confirmou, então vou aguardar o comprovante 😊" e "O áudio veio
// mudo, então vou pedir pra escrever 🙏" têm a mesma forma e são fala com o paciente: sem esse vocabulário, passam.
const NARRA_META = new RegExp(
  `${BORDA_E}(?:(?:mensagem|resposta|fala|pergunta)\\s+d[oa]\\s+paciente|(?:o|a)\\s+paciente\\s+(?:s[oó]|ainda|j[aá]|parece|tentou|est[aá]\\s+(?:encerrando|pedindo|repetindo))|resposta\\s+do\\s+paciente|com\\s+(?:o|a)\\s+paciente|lead|fluxo|cumprimento|transcri[cç][aã]o|triagem|engajamento|qualifica[cç]|instru[cç]|regra\\s+d[aeo]s?\\s+(?:["“]|s[oó]\\s|insist|rea[cç][aã]o|elogio)|pergunta\\s+d[ao]\\s+(?:equipe|paciente)|resposta\\s+d[ao]\\s+(?:equipe|paciente)|n[aã]o\\s+(?:traz|corresponde)|agradeceu\\s+e\\s+encerrou|mesma\\s+conversa|(?:eu|j[aá])\\s+respondi|ainda\\s+n[aã]o\\s+tenho|inst[aâ]ncia|hist[oó]rico\\s+completo|resposta\\s+da\\s+pessoa|confirma[cç][aã]o\\s+clara)`,
  'iu',
);
const NARRA_DIRIGIDO = new RegExp(`${BORDA_E}(?:voc[eê]s?|vcs?|seu|sua|seus|suas|te|contigo|lhe|nosso|nossa)${BORDA_D}|\\?`, 'iu');

/** Devolve o trecho de abertura do parágrafo quando ele é uma narração de bastidor (ver acima). */
export function paragrafoNarraDecisao(paragrafo: string): string | null {
  const p = (paragrafo ?? '').trim();
  if (!NARRA_SUJEITO.test(p) && !NARRA_NOME.test(p)) return null;
  // olha só o começo: a narração acontece nas duas primeiras frases
  const inicio = p.slice(0, 260);
  const rel = NARRA_RELATO.exec(inicio);
  if (!rel) return null;
  const depois = inicio.slice(rel.index + rel[0].length);
  const dec = NARRA_DECISAO.exec(depois);
  if (!dec) return null;
  // "parece (estar|ser|ter vindo)" sozinho é fala de gente ("Esse conteúdo não parece ser deste atendimento, então vou ficar por
  // aqui" — recusa educada, dirigida à pessoa). Só vira raciocínio quando a mesma frase fala DE alguém em terceira pessoa.
  const ateDecisao = rel.index + rel[0].length + dec.index + dec[0].length;
  if (/^parece/i.test(rel[0]) && !NARRA_TERCEIRA.test(inicio.slice(0, ateDecisao))) return null;
  // Nada dirigido à pessoa (você/seu/te/pergunta) do começo até o fim da frase da decisão, em qualquer linha.
  const fimDaFrase = inicio.slice(ateDecisao).search(/[.!?\n]/);
  const ate = fimDaFrase < 0 ? inicio.length : ateDecisao + fimDaFrase;
  if (NARRA_DIRIGIDO.test(inicio.slice(0, ate))) return null;
  if (!NARRA_META.test(inicio.slice(0, ate))) return null;
  return p.slice(0, 80);
}

function primeiro(padroes: RegExp[], texto: string): string | null {
  for (const re of padroes) {
    const m = re.exec(texto);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

/**
 * Devolve o vazamento encontrado, ou null quando a resposta está limpa.
 * Só o PRIMEIRO achado é reportado — basta um para a mensagem não sair.
 */
export function detectarVazamento(texto: string): Vazamento | null {
  const t = (texto ?? '').trim();
  if (!t) return null;

  const tool = primeiro(TOOL_CALL, t);
  if (tool) return { tipo: 'tool_call_em_texto', trecho: tool };

  const bloco = primeiro(BLOCO_INTERNO, t);
  if (bloco) return { tipo: 'bloco_interno', trecho: bloco };

  const ph = primeiro(PLACEHOLDER, t);
  if (ph) return { tipo: 'placeholder_nao_preenchido', trecho: ph };

  const pt = primeiro(BASTIDOR_PT, t) ?? primeiro(RACIOCINIO_PT, t);
  if (pt) return { tipo: 'bastidor_em_portugues', trecho: pt };

  for (const paragrafo of t.split(/\n\s*\n/)) {
    const narra = paragrafoNarraDecisao(paragrafo);
    if (narra) return { tipo: 'bastidor_em_portugues', trecho: narra };
  }

  // O raciocínio em inglês só conta quando a mensagem é CURTA e quase toda em
  // inglês. Numa resposta longa em português, uma frase dessas é quase sempre
  // citação do paciente — e barrar aí custaria mensagem boa.
  const en = primeiro(RACIOCINIO_EN, t);
  if (en && t.length < 400 && proporcaoPortugues(t) < 0.25) {
    return { tipo: 'raciocinio_em_ingles', trecho: en };
  }

  return null;
}

/** Fração grosseira de "cara de português" — acento, ç, e palavras-função nossas. */
function proporcaoPortugues(t: string): number {
  const palavras = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return 1;
  const marcas = /[áàâãéêíóôõúüç]|^(o|a|os|as|de|da|do|que|não|para|com|você|seu|sua|pra|é|em|no|na|um|uma|se|já|te|meu|minha)$/;
  return palavras.filter((p) => marcas.test(p)).length / palavras.length;
}

/** Frase de rodapé pro log/alerta, em português de gente. */
export function explicarVazamento(v: Vazamento): string {
  switch (v.tipo) {
    case 'tool_call_em_texto':
      return 'a IA escreveu a chamada da ferramenta em vez de executá-la';
    case 'raciocinio_em_ingles':
      return 'a IA entregou o próprio raciocínio, em inglês, como se fosse fala';
    case 'placeholder_nao_preenchido':
      return 'ficou um marcador de template sem valor na mensagem';
    case 'bloco_interno':
      return 'um pedaço interno do prompt escapou para a resposta';
    case 'bastidor_em_portugues':
      return 'a IA escreveu uma anotação de bastidor (falou do paciente ou do que fez no sistema) em vez de falar com ele';
  }
}

/**
 * Quem reescreve um rascunho com bastidor. Chamada SEPARADA, sem o histórico e sem ferramentas: pedir
 * a correção dentro da conversa (como o juiz da pergunta final faz) já gerou o efeito contrário — o
 * modelo, treinado para desconfiar de comando que chega na mensagem do paciente, respondia SOBRE a
 * instrução ("essa 'instrução interna' veio dentro da mensagem do paciente…"), e isso também vazava.
 */
export const SISTEMA_REESCRITOR_BASTIDOR = [
  'Você revisa mensagens de WhatsApp de uma atendente virtual antes de saírem para o cliente.',
  'Você recebe a última mensagem do cliente e um RASCUNHO que saiu errado: em vez de falar com o cliente, ele',
  'narra o que a atendente fez no sistema, mostra o raciocínio dela, ou fala do cliente em terceira pessoa.',
  'Escreva a mensagem que o cliente deve receber agora:',
  '- em segunda pessoa (você), curta (1 a 3 frases), no mesmo tom e idioma do rascunho;',
  '- aproveite só o que já era fala para o cliente; se não houver nada, responda de forma natural à última mensagem dele;',
  '- nunca mencione campos, registros, etapas, ações, instruções, "paciente" ou "lead";',
  '- não invente preço, data, horário nem promessa que não estejam no rascunho.',
  'Responda só com a mensagem final, sem aspas.',
].join('\n');

export function pedidoAoReescritor(ultimaDoCliente: string | null, rascunho: string): string {
  return `Última mensagem do cliente:\n${(ultimaDoCliente ?? '(sem texto)').slice(0, 1500)}\n\nRascunho que saiu errado:\n${rascunho.slice(0, 2000)}`;
}

/**
 * Marca de abertura que fala da transcrição do áudio (coisa do sistema, que o paciente não conhece). Sobra depois do corte com
 * isso dentro = o raciocínio continua lá: volta igual e o reescritor resolve.
 */
// Sem `\b`: com acento ("áudio", "você", "está") ele falha em JS — bordas por letra/número (definidas acima).
const SOLTA = BORDA_E;
const FIM = BORDA_D;
const ABERTURA_META = new RegExp(`${SOLTA}(?:transcri[cç][aã]o|[aá]udio\\s+(?:dele|dela|veio|saiu|chegou|ficou))${FIM}`, 'iu');
const TERCEIRA_PESSOA = new RegExp(`${SOLTA}(?:ele|ela|dele|dela|o\\s+paciente|a\\s+paciente)${FIM}`, 'iu');
const DIRIGIDO_AO_PACIENTE = new RegExp(`${SOLTA}(?:voc[eê]s?|vcs?|seu|sua|seus|suas|te|contigo|lhe|lhes)${FIM}`, 'iu');

/**
 * A fala "de verdade" ao paciente: tem uma palavra dirigida a ele (você/seu/te) ou começa por cumprimento. Só "?" não basta: "Como posso ajudar agora?" também fecha raciocínio. É a prova de que o que
 * sobra depois do corte é mensagem, e não mais uma linha do mesmo raciocínio que o detector não conhece.
 */
const FALA_AO_PACIENTE = new RegExp(`^\\s*(?:oi|ol[aá]|bom\\s+dia|boa\\s+(?:tarde|noite))${FIM}|${SOLTA}(?:voc[eê]s?|vcs?|seu|sua|seus|suas|te|contigo|lhe|lhes)${FIM}`, 'iu');

/**
 * Parágrafo que é bastidor puro: o detector o reconhece como `bastidor_em_portugues` e ele não fala com ninguém (sem "você",
 * "seu", "te", sem pergunta). Cortá-lo não tira informação nenhuma do paciente.
 */
function ehBastidorPuro(paragrafo: string): boolean {
  if (detectarVazamento(paragrafo)?.tipo !== 'bastidor_em_portugues') return false;
  return !DIRIGIDO_AO_PACIENTE.test(paragrafo) && !paragrafo.includes('?');
}


/** "350", "350.", "350,00" e "1.200" viram o mesmo número que a fala escreveria; "50" nunca é "250". */
function numeroInteiro(txt: string): string {
  let t = txt.replace(/[.,]+$/, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  return String(Number(t.replace(',', '.')));
}

interface Fatos {
  dinheiro: Set<string>;
  horas: Set<string>;
  datas: Set<string>;
  dias: Set<string>;
  telefones: Set<string>;
  links: Set<string>;
}

/** Dados conferíveis de um texto: valores, horas EXATAS (3h ≠ 13h, 10h ≠ 10h30), datas, telefones e links. */
function fatosDoTexto(t: string): Fatos {
  const f: Fatos = { dinheiro: new Set(), horas: new Set(), datas: new Set(), dias: new Set(), telefones: new Set(), links: new Set() };
  for (const m of t.matchAll(/R\$\s*(\d[\d.,]*)/gi)) f.dinheiro.add(numeroInteiro(m[1]));
  for (const m of t.matchAll(/(?<![\d.,/:])(\d[\d.,]*)\s*(?:reais|real)(?![\p{L}])/giu)) f.dinheiro.add(numeroInteiro(m[1]));
  // hh:mm / hhhmm ("10h30", "15:00horas") e hora cheia ("10h", "10 horas"); "3 hérnias" não é "3h" (letra depois do h)
  for (const m of t.matchAll(/(?<![\d/:.,])(\d{1,2})\s*[h:](\d{2})(?!\d)/gi)) f.horas.add(`${Number(m[1])}:${m[2]}`);
  for (const m of t.matchAll(/(?<![\d/:.,])(\d{1,2})\s*(?:h|horas?)(?![\p{L}\d])/giu)) f.horas.add(`${Number(m[1])}:00`);
  for (const m of t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) {
    const ano = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : '';
    f.datas.add(`${Number(m[1])}/${Number(m[2])}${ano ? `/${ano}` : ''}`);
  }
  for (const m of t.matchAll(/(?<![\p{L}])dia\s+(\d{1,2})(?![\d/])/giu)) f.dias.add(String(Number(m[1])));
  for (const m of t.matchAll(/\+?\d[\d\s().-]{7,}\d/g)) {
    const so = m[0].replace(/\D/g, '');
    if (so.length >= 8) f.telefones.add(so);
  }
  for (const m of t.matchAll(/(?:https?:\/\/|www\.)[^\s<>"')]+/gi)) f.links.add(m[0].replace(/[.,;:!?]+$/, '').toLowerCase());
  return f;
}

const ENDERECO = /(?<![\p{L}\p{N}_])(?:rua|avenida|av\.|travessa|alameda|pra[cç]a|rodovia|endere[cç]o|bairro|cep|andar|sala|km|n[º°])(?![\p{L}\p{N}_])/iu;

/**
 * Todo valor, hora, data, telefone e link do trecho cortado também está na fala que fica? Comparação por valor INTEIRO: "R$ 50" não
 * está em "R$ 250", "3h" não está em "13h" nem "10h" em "10h30". Data "18/11" conta se a fala traz a mesma data ou "dia 18"; "18/11/2026" exige a data inteira.
 * Endereço (rua, avenida, bairro, CEP…) no trecho cortado reprova sempre: não dá para conferir.
 */
function fatosCabemNaFala(cortado: string, fala: string): boolean {
  if (ENDERECO.test(cortado)) return false;
  const a = fatosDoTexto(cortado);
  const b = fatosDoTexto(fala);
  const todos = (de: Set<string>, em: Set<string>) => [...de].every((x) => em.has(x));
  if (!todos(a.dinheiro, b.dinheiro) || !todos(a.horas, b.horas) || !todos(a.telefones, b.telefones) || !todos(a.links, b.links)) return false;
  // Data com ano exige a MESMA data na fala; sem ano, vale a mesma dd/mm ou "dia dd".
  return [...a.datas].every((d) => {
    if (d.split('/').length === 3) return b.datas.has(d);
    return b.datas.has(d) || [...b.datas].some((x) => x.startsWith(`${d}/`)) || b.dias.has(d.split('/')[0]);
  });
}

/**
 * O raciocínio vem ANTES da fala, em parágrafo próprio. Casos reais:
 *   • Caxias 13/11/2026: "A transcrição do áudio veio bem genérica, sem contar de fato o que ele está sentindo 😊 Vou pedir pra
 *     ele mesmo me contar, com as próprias palavras.\n\nOi! 👋 … Me conta, o que você está sentindo?"
 *   • 16/11/2026 20:54 (Aparecida): "A equipe já confirmou a consulta dela… — não preciso agir sobre isso, só responder o
 *     cumprimento.\n\nBoa tarde, Aparecida! Tudo certo então, nos vemos no dia 18, às 10h15."
 *   • 03/11/2026 13:05: "Preciso confirmar algo antes de responder: a equipe enviou um áudio e não tenho o conteúdo dele
 *     transcrito, então vou seguir com cautela aqui.\n\nBom dia! 😊 Que bom falar com você de novo!"
 * Corta os parágrafos de abertura que são bastidor puro, e só quando sobra fala para o paciente: o que sobra precisa começar
 * dirigido a ele (cumprimento ou "você/seu/te") e o detector não pode reconhecer mais nada nele. Resposta de um
 * parágrafo só, parágrafo de abertura que fala com a pessoa, ou sobra que não parece fala voltam IGUAIS: quem decide é o
 * detector (`detectarVazamento`) e o reescritor. "Não consegui ouvir seu áudio, pode escrever?" fala com "seu" e passa.
 */
export function cortarAberturaMetanarrativa(texto: string): string {
  const partes = (texto ?? '').split(/\n\s*\n/);
  if (partes.length < 2) return texto;

  // Caminho ANTIGO (Caxias, 13/11), mantido como era: a abertura que fala da transcrição do áudio em 3ª pessoa sai sem exigir
  // cumprimento/"você" no que sobra ("Entendi! Me conta o que está sentindo?" serve). Só acrescenta a conferência de dados.
  const [abertura, ...resto] = partes;
  if (ABERTURA_META.test(abertura) && detectarVazamento(abertura) && TERCEIRA_PESSOA.test(abertura) && !DIRIGIDO_AO_PACIENTE.test(abertura)) {
    const sobraAntiga = resto.join('\n\n').trim();
    if (!sobraAntiga || ABERTURA_META.test(sobraAntiga) || detectarVazamento(sobraAntiga) || !fatosCabemNaFala(abertura, sobraAntiga)) return texto;
    return sobraAntiga;
  }

  let n = 0;
  while (n < partes.length - 1 && ehBastidorPuro(partes[n])) n++;
  if (n === 0) return texto;
  const sobra = partes.slice(n).join('\n\n').trim();
  if (!sobra || ABERTURA_META.test(sobra) || detectarVazamento(sobra)) return texto;
  if (!FALA_AO_PACIENTE.test(partes[n])) return texto;
  // Dado que estava só no raciocínio não some em silêncio: valor (R$ ou "350 reais"), hora, data, telefone, link e endereço têm que
  // aparecer também na fala; endereço no trecho cortado = não corta. Na dúvida, o reescritor decide.
  if (!fatosCabemNaFala(partes.slice(0, n).join('\n\n'), sobra)) return texto;
  return sobra;
}
