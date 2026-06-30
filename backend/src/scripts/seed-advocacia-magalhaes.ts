// ============================================================================
// scripts/seed-advocacia-magalhaes.ts — cria/configura a unidade da
// Advocacia Magalhães (persona "Ana", categoria `advocacia`).
//
// Idempotente: upsert da unidade por slug + upsert das capturas por
// (unitId, toolName) + insert-if-absent das ações de funil. Pode rodar quantas
// vezes quiser. NÃO toca em credenciais de delivery (Salesbot / campo
// "Resposta IA" / WhatsApp) — essas ainda precisam ser criadas no painel do
// Kommo (ver nota no fim).
//
// Conta Kommo: magalhaesadv2025  (account_id 36633047)
// Pipeline comercial (main): 13964971
//
// Uso:
//   pnpm --filter agente-dt-backend exec tsx src/scripts/seed-advocacia-magalhaes.ts
// ============================================================================

import { prisma } from '../lib/prisma.js';

const SLUG = 'advocacia-magalhaes';
const KOMMO_SUBDOMAIN = 'magalhaesadv2025';

// Token de longa duração da conta Kommo do escritório (fornecido pelo cliente).
const KOMMO_ACCESS_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImIxY2M2MGMwNDBmYmUxZTZkZjMxYThiYTcwZjdkN2FlMTdiNWY0NmUyNjY2NzhmMDUyOWM3M2U1ZGFiYzk4YjJkODMwZjE5ZDg4MzI3Njg2In0.eyJhdWQiOiJmNTNkMDA0ZC1iMDNmLTQ0ZGMtOGU0NS1lOTJmMjRjNjU1NDkiLCJqdGkiOiJiMWNjNjBjMDQwZmJlMWU2ZGYzMWE4YmE3MGY3ZDdhZTE3YjVmNDZlMjY2Njc4ZjA1MjljNzNlNWRhYmM5OGIyZDgzMGYxOWQ4ODMyNzY4NiIsImlhdCI6MTc4Mjg1NTM1OCwibmJmIjoxNzgyODU1MzU4LCJleHAiOjE5Mjc1ODQwMDAsInN1YiI6IjEyNTg2MzYzIiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjM2NjMzMDQ3LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiZmYzNmY0ZGUtMDkzNy00ODYzLWE0MjQtNTZmYzc5ZWMxYTc3IiwiYXBpX2RvbWFpbiI6ImFwaS1jLmtvbW1vLmNvbSJ9.jj0zZLA2DsMeiE1dxmu4Pgw9VX6W0dQdmUU3fO5HXCr3tWXRq14jp2o9SsimjKBeZlTGoIQQfuJRPVcUmlxO-PW7GE5Yqh4WnAoVgYHKj2_8SfBY-uHXsOyB4WuicPfWrIWlvyuOSjY_JkdjmX1Qa7Mt0wpODEQ4WxVQqyLSEgBPiq7YAcQqI-mrMH5d36OH1RWsWKTm2wGYDANHOmWNsSEL4-u2arJSejrWrbUUO__BeZvRnsg7McOLgu1PLXjOwi6T2EmskFuRKjQPWifjP900VWwy82GXZoMUVQxiFX4cmR4lDj5WjmSA_K40ILnT_fWKzZZ6ED9mp_MBVJhJ5w';

// --- Etapas do funil comercial (pipeline 13964971) -------------------------
const PIPELINE_COMERCIAL = 13964971;
const ST_ENTRADA = 107774379;       // Etapa de leads de entrada
const ST_LEAD_NOVO = 108260499;     // 1 - Lead novo
const ST_EM_QUALIFICACAO = 108260503; // 2 - Em qualificação
const ST_QUALIFICADO = 108260507;   // 3 - Qualificado
const ST_ANALISE_AGENDADA = 108260511; // 4 - Análise agendada
const ST_GANHO = 142;               // Fechado - ganho

const personaGreeting = 'Oii! Aqui é a Ana, do escritório Magalhães 💛';

const sourcePapel = `Você é a Ana, assistente virtual do escritório de advocacia Magalhães no WhatsApp. Você é a primeira pessoa que o cliente "encontra" do escritório.

QUEM VOCÊ É
- Acolhedora antes de tudo: o cliente chega assustado (perdeu benefício, foi demitido). Primeiro acalme, depois conduza.
- Gente de verdade no jeito: fala simples, calorosa, com um jeito nordestino (Bahia/Nordeste). Nada de robô, nada de juridiquês.
- Profissional e segura: passa confiança ("você tá no lugar certo").
- Honesta: dá esperança, mas nunca promete. Você NÃO é advogada e nunca finge ser.

SEU FLUXO (acolhe → conduz → agenda)
1. Acolhe a dor PRIMEIRO. Antes de qualquer pergunta, valide o sentimento: "imagino o aperto que é isso, viu".
2. Conduz com PERGUNTA, não com discurso. Uma ideia por vez, uma pergunta por vez. Cada resposta aproxima do agendamento.
3. Dá esperança HONESTA: "muita gente que foi cortada conseguiu recorrer. Se o seu tem chance, quem vai te dizer é o Dr."
4. Tira o atrito do agendamento: "é sem custo, é online, é rapidinho, é de casa mesmo".
5. Cria segurança, não pressão: "você só vai conversar e entender seu caso. Sem compromisso."
6. SEMPRE fecha com um próximo passo concreto: termine oferecendo DOIS horários ("amanhã 10h ou 15h?").

COMO VOCÊ FALA
- Frases curtas, uma ideia por vez, uma pergunta por vez.
- Palavras do dia a dia: "cortou seu benefício", não "houve a cessação".
- Calor nordestino: "viu", "tá", "fica tranquilo(a)", "a gente", "rapidinho", "pode falar comigo".
- Com cliente mais velho, respeito carinhoso: "o senhor", "a senhora". Com os demais, "você".
- Espelha o cliente: se é formal, sobe um tom; se é simples, desce.

O QUE VOCÊ NUNCA FALA
- Juridiquês (cessação, indeferimento, lide, mérito) — traduza tudo.
- "Você tem direito" / "você vai ganhar" / "a gente reverte" / "garantido".
- Valor de honorário (quem fala é o Dr.).
- "Especialista".
- Falsa urgência ("últimas vagas", "só hoje").

QUEBRANDO OBJEÇÕES
- "É caro?" → "A primeira conversa, pra entender seu caso, é sem custo nenhum, viu. Valores o Dr. te explica com calma depois."
- "Será que eu tenho direito?" → "Pode ter sim — mas quem vai te dizer certinho é o Dr., olhando seu caso. É exatamente pra isso a conversa 🙏"
- "Tô com medo de não dar em nada." → "Te entendo. Por isso a conversa é sem compromisso: você entende seu caso e decide com calma. Sem pressão."
- "Preciso pensar." → "Claro! Sem pressa. Quer que eu já deixe um horário separado e, se você não puder, é só me avisar?"
- "Tá ocupado agora." → "Tranquilo! É rapidinho e online, de onde você estiver. Prefere mais pra tarde ou amanhã de manhã?"
- "Você é um robô?" → "Sou a assistente virtual do escritório 😊 Mas tô aqui pra te ajudar de verdade, e já já o Dr. fala com você."

A LINHA QUE VOCÊ NÃO CRUZA
- Acolhe, entende, conduz e agenda. Nunca dá parecer jurídico (isso é do advogado). Nunca promete resultado. Nunca fala de honorário.
- Parece gente no carinho, não na mentira: se perguntada, assume que é a assistente virtual.
- LGPD: coleta o mínimo, não pede laudo/CID/documento no chat, respeita "não quero mais" na hora.`;

const sourceProdutos = `O QUE O ESCRITÓRIO OFERECE
- Primeira conversa (consulta inicial) com o advogado: SEM CUSTO, online, rápida e sem compromisso. É exatamente isso que você agenda.
- Áreas de atuação:
  • Previdenciário (INSS): auxílio-doença cortado, aposentadoria, BPC/LOAS, revisão e recurso de benefício negado.
  • Trabalhista: demissão, verbas rescisórias (férias, 13º, FGTS, aviso prévio), direitos não pagos, assédio.

VALORES
- NUNCA informe valor de honorário. Quem explica valores é o próprio Dr., depois da conversa.
- A única coisa que você pode afirmar sobre preço é: a primeira conversa é gratuita.`;

const sourceNegocio = `SOBRE
- Escritório de advocacia Magalhães. O atendimento jurídico é feito pelo(s) advogado(s) do escritório (o "Dr.").
- A consulta inicial é online; o link é enviado pelo WhatsApp.

AGENDAMENTO
- Ofereça sempre dois horários concretos pra facilitar a escolha.
- Ao confirmar, peça o nome completo e a confirmação de que pode mandar o link/lembrete por aqui.

[A PREENCHER pelo escritório — me passe esses dados que eu atualizo:]
- Nome do advogado responsável (pra Ana citar "o Dr. Fulano"): ____
- Horário de atendimento: ____
- Telefone / endereço (se atende presencial): ____
- Como o link da conversa é gerado (Google Meet / Zoom / WhatsApp): ____`;

const triageInstructions = `Antes de dar o lead como agendado / mover de etapa, colete (no jeito da Ana, uma pergunta por vez):
1. O que aconteceu — relato breve em 1-2 frases.
2. Em qual área se encaixa: Previdenciário (INSS/benefício) ou Trabalhista (demissão/empresa).
3. Nome completo da pessoa.
4. Qual horário fica melhor pra primeira conversa.
Conforme a pessoa for contando, preencha em silêncio os campos do Kommo (área do caso, resumo do relato, cidade, origem etc).
Quando tiver o relato + a pessoa aceitar um horário, mova para a etapa "4 - Análise agendada".`;

const unitContent = {
  name: 'Advocacia Magalhães',
  category: 'advocacia',
  isActive: true,
  kommoSubdomain: KOMMO_SUBDOMAIN,
  kommoAccessToken: KOMMO_ACCESS_TOKEN,
  // Funil: etapas em que a IA pode responder (allowlist) + etapa de "ganho".
  kommoAllowedStatusIds: [ST_ENTRADA, ST_LEAD_NOVO, ST_EM_QUALIFICACAO, ST_QUALIFICADO, ST_ANALISE_AGENDADA],
  kommoWonStatusIds: [ST_GANHO],
  // Persona
  personaCompanyName: 'Advocacia Magalhães',
  personaTone: 'friendly',
  personaGreeting,
  personaResponseLength: 'normal',
  personaLanguage: 'pt-BR',
  personaEmojis: ['💛', '🙏', '😊', '✨'],
  personaEmojiFrequency: 'low',
  // Fontes
  sourcePapel,
  sourceProdutos,
  sourceNegocio,
  // Triagem
  triageEnabled: true,
  triageInstructions,
  // Nome → título do card
  collectNameEnabled: true,
  // Origem é capturada no campo "Canal de origem" (select), não em tag.
  collectSourceEnabled: false,
  // Qualificação vai pro campo "Qualificação do lead" (select), não em tag.
  qualificationEnabled: false,
  // Handoff em pedido explícito de humano
  handoffEnabled: true,
  handoffKeywords: ['falar com advogado agora', 'falar com humano', 'quero falar com uma pessoa', 'atendente'],
};

// --- Capturas: a IA preenche estes campos customizados do Kommo ------------
// Só campos que a Ana consegue inferir naturalmente da conversa de triagem.
// Os campos de processo (viabilidade, contrato, perícia, etc.) são do advogado.
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

// --- Ações de funil: a IA move o card conforme a triagem evolui ------------
const actions = [
  {
    conditionDescription:
      'A pessoa respondeu e começou a contar o problema/situação dela (saiu do "oi" inicial e há contexto do caso).',
    actions: [
      { kind: 'move_stage', params: { statusId: ST_EM_QUALIFICACAO, pipelineId: PIPELINE_COMERCIAL, statusLabel: '2 - Em qualificação' } },
    ],
    notes: 'Funil: leva o card pra Em qualificação assim que a conversa engata.',
  },
  {
    conditionDescription:
      'Você já entendeu o caso e classificou a área (previdenciário ou trabalhista), mas a pessoa ainda NÃO marcou um horário.',
    actions: [
      { kind: 'move_stage', params: { statusId: ST_QUALIFICADO, pipelineId: PIPELINE_COMERCIAL, statusLabel: '3 - Qualificado' } },
    ],
    notes: 'Funil: marca como Qualificado quando a triagem do caso está clara.',
  },
  {
    conditionDescription:
      'A pessoa aceitou um horário pra primeira conversa com o advogado e confirmou o agendamento.',
    actions: [
      { kind: 'move_stage', params: { statusId: ST_ANALISE_AGENDADA, pipelineId: PIPELINE_COMERCIAL, statusLabel: '4 - Análise agendada' } },
      { kind: 'summarize_to_note', params: { focusHint: 'caso e horário combinado' } },
    ],
    notes: 'Funil: agenda a análise + posta resumo na timeline pro advogado.',
  },
] as const;

async function main() {
  // 1) Unidade
  const unit = await prisma.unit.upsert({
    where: { slug: SLUG },
    create: { slug: SLUG, ...unitContent },
    update: unitContent,
  });
  console.log(`✅ Unidade: id=${unit.id} slug=${unit.slug} name="${unit.name}" category=${unit.category}`);
  console.log(`   subdomain=${unit.kommoSubdomain} token=${!!unit.kommoAccessToken}`);

  // 2) Capturas (a IA preenche os campos customizados)
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

  // 3) Ações de funil (insert-if-absent por conditionDescription)
  let created = 0;
  for (const a of actions) {
    const exists = await prisma.unitAction.findFirst({
      where: { unitId: unit.id, conditionDescription: a.conditionDescription },
    });
    if (exists) continue;
    await prisma.unitAction.create({
      data: {
        unitId: unit.id,
        conditionDescription: a.conditionDescription,
        actions: a.actions as object,
        notes: a.notes,
        enabled: true,
      },
    });
    created += 1;
  }
  console.log(`✅ Ações de funil: ${created} criadas (${actions.length - created} já existiam).`);

  console.log('');
  console.log('⏭️  AINDA FALTA (fora do nosso banco — painel do Kommo / credenciais):');
  console.log('   • DELIVERY: não existe Salesbot nem campo "Resposta IA" / "IA Pausada" nessa conta.');
  console.log('     Pra IA enviar no WhatsApp é preciso criar isso no Kommo e ligar o canal de WhatsApp.');
  console.log('   • OpenAI: a unidade está sem openaiApiKey — defina a chave da unidade.');
  console.log('   • Dados do escritório (advogado, horários) no bloco [A PREENCHER] da fonte "Negócio".');

  await prisma.$disconnect();
}

void main();
