// ============================================================================
// prompt-composer.ts — Monta o systemPrompt efetivo a partir do Unit + features.
//
// LÓGICA DE ENGENHARIA
// --------------------
// O `Unit.systemPrompt` é o texto base que o usuário escreve (persona +
// missão + tom). As features do wizard (qualificação, handoff, horário,
// etc) são CAMPOS ESTRUTURADOS na Unit. Esta função renderiza cada feature
// ativa em um bloco de texto e concatena tudo num prompt final.
//
// O leigo nunca precisa escrever instruções tipo "se cliente disser X faça Y"
// — ele só ativa toggles. O composer traduz os toggles em linguagem que a
// LLM entende.
//
// USO
// ---
//   const finalPrompt = composeSystemPrompt(unit, agentConfigPrompt);
//   ...passa pra LLM.
// ============================================================================

import type { KnowledgeBaseEntry, MessageTemplate, Unit, UnitAction } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { searchKnowledge } from '../services/knowledge.service.js';
import { listEnabledActions } from '../services/actions.service.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// Resultado da checagem de horário comercial.
// ---------------------------------------------------------------------------

export interface BusinessHoursStatus {
  /** Feature ativada na Unit? */
  enabled: boolean;
  /** Está dentro do horário comercial agora? (true se feature desativada). */
  isOpen: boolean;
  /** Mensagem padrão pra responder fora do horário (se configurada). */
  outOfHoursMessage: string | null;
}

/**
 * Verifica se o momento atual está dentro do horário comercial da Unit.
 * Se a feature estiver desativada, sempre retorna `isOpen: true`.
 */
export function checkBusinessHours(unit: Unit, now: Date = new Date()): BusinessHoursStatus {
  if (!unit.businessHoursEnabled) {
    return { enabled: false, isOpen: true, outOfHoursMessage: unit.outOfHoursMessage };
  }
  const tz = unit.businessHoursTimezone || 'America/Sao_Paulo';
  // Usamos Intl pra converter pro fuso da Unit sem dependência externa.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = (parts.find((p) => p.type === 'weekday')?.value ?? '').toLowerCase().slice(0, 3);
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
  const hour = Number(hourStr) % 24;
  const allowedDays = new Set(unit.businessHoursDays);
  const isOpenDay = allowedDays.has(weekday);
  const isOpenHour = hour >= unit.businessHoursStart && hour < unit.businessHoursEnd;
  return {
    enabled: true,
    isOpen: isOpenDay && isOpenHour,
    outOfHoursMessage: unit.outOfHoursMessage,
  };
}

// ---------------------------------------------------------------------------
// Tom de voz por persona.
// ---------------------------------------------------------------------------

function renderToneInstruction(tone: string | null): string {
  switch (tone) {
    case 'formal':
      return 'Tom: formal, profissional, usando "senhor(a)" quando apropriado.';
    case 'friendly':
      return 'Tom: caloroso e amigável, com emojis ocasionais (😊, 🙏), tratando o cliente como amigo.';
    case 'casual':
      return 'Tom: descontraído, em PT-BR informal, usando "você". Sem emojis a não ser que o cliente use primeiro.';
    default:
      return 'Tom: equilibrado entre formal e descontraído, em PT-BR.';
  }
}

// ---------------------------------------------------------------------------
// Renders parciais de cada feature.
// ---------------------------------------------------------------------------

function renderPersona(unit: Unit): string {
  const lines: string[] = ['# PERSONA'];
  const company = unit.personaCompanyName?.trim();
  if (company) {
    lines.push(`Você é o atendente virtual da ${company}, conversando pelo WhatsApp com clientes.`);
  } else {
    lines.push('Você é o atendente virtual da empresa, conversando pelo WhatsApp com clientes.');
  }
  lines.push(renderToneInstruction(unit.personaTone));
  lines.push(renderResponseLength(unit.personaResponseLength));
  lines.push(renderLanguage(unit.personaLanguage));
  const greeting = unit.personaGreeting?.trim();
  if (greeting) {
    lines.push(`Saudação preferida (use quando for o primeiro contato): "${greeting}"`);
  }
  return lines.join('\n');
}

function renderResponseLength(length: string | null | undefined): string {
  switch (length) {
    case 'curta':
      return 'Tamanho: respostas MUITO curtas, 1 frase. Vá direto ao ponto.';
    case 'detalhada':
      return 'Tamanho: respostas detalhadas, parágrafos curtos. Explique com contexto quando útil.';
    case 'normal':
    default:
      return 'Tamanho: respostas curtas, 1 a 3 frases. WhatsApp não é email.';
  }
}

function renderLanguage(lang: string | null | undefined): string {
  const map: Record<string, string> = {
    'pt-BR': 'Idioma: português do Brasil. Use "você", evite "tu/vós".',
    'en-US': 'Language: respond in English (US). Adapt tone naturally.',
    'es-ES': 'Idioma: responde en español. Adapta el tono naturalmente.',
    'fr-FR': 'Langue: réponds en français. Adapte le ton naturellement.',
  };
  return map[lang ?? 'pt-BR'] ?? map['pt-BR'];
}

function renderSources(unit: Unit): string {
  const sections: string[] = [];
  const papel = unit.sourcePapel?.trim();
  const produtos = unit.sourceProdutos?.trim();
  const negocio = unit.sourceNegocio?.trim();
  if (papel) {
    sections.push(`# FATOS IMPORTANTES (PAPEL E FLUXO)\n${papel}`);
  }
  if (produtos) {
    sections.push(`# PRODUTOS E SERVIÇOS\n${produtos}`);
  }
  if (negocio) {
    sections.push(`# VISÃO GERAL DO NEGÓCIO\n${negocio}`);
  }
  return sections.join('\n\n');
}

function renderRulesGlobal(): string {
  return `# REGRAS GERAIS DE TOM
- Respostas curtas: 1 a 3 frases. WhatsApp não é email.
- NUNCA use as palavras técnicas: "lead", "ID", "tag", "etapa", "pipeline", "tool", "campo", "sistema", "erro", "API", "função".
- Se algo deu errado por trás (tool falhou), NÃO conte ao cliente. Responda como se tudo estivesse normal.
- Tool errors são telemetria interna que você ignora completamente na resposta visível ao cliente.`;
}

function renderQualification(unit: Unit): string {
  if (!unit.qualificationEnabled) return '';
  return `# AUTO-QUALIFICAÇÃO
- Aplique tag "${unit.qualificationHotTag}" via aplicar_tag quando houver sinal claro de compra:
  cliente pediu orçamento/preço, demonstrou urgência, mencionou decisão, ou disse "quero comprar".
- Aplique tag "${unit.qualificationColdTag}" quando o cliente pedir pra não ser contatado, dizer
  que não tem interesse, ou usar tom ofensivo.
- A tag é silenciosa. NÃO mencione na resposta ao cliente.`;
}

function renderHandoff(unit: Unit): string {
  if (!unit.handoffEnabled) return '';
  const kws = (unit.handoffKeywords ?? []).filter(Boolean);
  if (kws.length === 0) {
    return `# HANDOFF HUMANO
- Quando o cliente pedir explicitamente um humano ("atendente", "falar com pessoa",
  "humano"), chame pausar_ia e responda: "Claro! Vou chamar alguém da equipe pra te
  atender. Um instante 🙏". Não tente continuar a conversa.`;
  }
  const list = kws.map((k) => `"${k}"`).join(', ');
  return `# HANDOFF HUMANO
- Se o cliente usar QUALQUER uma destas palavras/frases (mesmo aproximadas), chame
  pausar_ia imediatamente:
  ${list}
- Após pausar, responda apenas: "Claro! Vou chamar alguém da equipe pra te atender. Um instante 🙏".
  Não continue a conversa depois disso.`;
}

function renderPipelineIntents(unit: Unit): string {
  const intents = unit.pipelineIntents as Record<string, number> | null;
  if (!intents || Object.keys(intents).length === 0) return '';
  const labelMap: Record<string, string> = {
    asked_quote: 'pediu orçamento/preço',
    confirmed_order: 'confirmou que vai comprar/contratar',
    scheduled_meeting: 'agendou reunião/consulta',
    paid: 'confirmou pagamento',
    abandoned: 'sumiu sem responder por dias',
    refused: 'recusou explicitamente',
  };
  const lines = Object.entries(intents).map(([intent, statusId]) => {
    const label = labelMap[intent] ?? intent;
    return `  - Cliente ${label} → chame mover_etapa(${statusId})`;
  });
  return `# PIPELINE POR INTENÇÃO
- Mova o lead automaticamente conforme detectar essas intenções:\n${lines.join('\n')}
- A movimentação é silenciosa. NÃO mencione na resposta ao cliente.`;
}

function renderContactCollection(unit: Unit): string {
  if (!unit.contactCollectionEnabled) return '';
  const n = unit.contactCollectionAfterTurns;
  return `# COLETA PROATIVA DE CONTATO
- Após ${n} turnos de conversa, se você AINDA não tiver email ou telefone do cliente,
  peça de forma natural numa das suas respostas. Exemplos:
  "Pra te enviar mais detalhes, qual seu melhor email?"
  "Tem um WhatsApp/telefone melhor pra eu te enviar a proposta?"
- Não pergunte antes do turno ${n}. Não pergunte mais de uma vez.`;
}

function renderWelcomeCoupon(unit: Unit): string {
  if (!unit.welcomeCouponEnabled) return '';
  const msg = unit.welcomeCouponMessage?.trim();
  return `# CUPOM DE BOAS-VINDAS
- Se for o PRIMEIRO contato do cliente (apenas 1 mensagem na conversa até agora),
  mencione o cupom de boas-vindas: ${msg ? `"${msg}"` : '<mensagem do cupom não configurada — pule>'}
- Não mencione o cupom mais de uma vez na mesma conversa.`;
}

function renderBusinessHours(unit: Unit): string {
  if (!unit.businessHoursEnabled) return '';
  const days = unit.businessHoursDays.join(', ');
  return `# HORÁRIO COMERCIAL
- Atendimento ativo: ${days}, das ${unit.businessHoursStart}h às ${unit.businessHoursEnd}h
  (${unit.businessHoursTimezone}).
- Quando o cliente escrever fora do horário, esta IA NÃO responde (o sistema envia
  mensagem automática separada). Você não precisa se preocupar com isso — apenas
  responda normalmente quando estiver no ar.`;
}

function renderFollowUp(unit: Unit): string {
  if (!unit.followUpEnabled) return '';
  const msg = unit.followUpMessage?.trim();
  return `# FOLLOW-UP
- Se a conversa terminar sem fechar (cliente ficou em dúvida, pediu pra pensar),
  ofereça um follow-up cordial. Exemplo de mensagem de fechamento:
  ${msg ? `"${msg}"` : '"Sem pressão, fica à vontade. Te chamo daqui ${unit.followUpAfterHours}h pra ver se posso ajudar em algo, ok?"'}`;
}

function renderTemplates(templates: MessageTemplate[]): string {
  if (templates.length === 0) return '';
  const lines = templates.map((t, i) => {
    const kws = t.triggerKeywords.length ? `[gatilhos: ${t.triggerKeywords.join(', ')}]` : '[sem gatilho fixo]';
    return `${i + 1}. ${t.name} ${kws}\n   "${t.response.replace(/\n/g, ' ').slice(0, 280)}"`;
  });
  return `# RESPOSTAS PRONTAS (templates)
- Quando o cliente usar alguma das palavras-chave de gatilho abaixo, prefira a
  resposta pronta correspondente (pode adaptar levemente o tom, mas mantenha
  a informação igual). NÃO mencione que está usando template.

${lines.join('\n\n')}`;
}

function renderFlaggedExamples(flagged: Array<{ content: string }>): string {
  if (flagged.length === 0) return '';
  const lines = flagged.slice(0, 10).map((m, i) => `${i + 1}. "${m.content.slice(0, 200)}"`);
  return `# EXEMPLOS DE RESPOSTAS RUINS (NÃO REPITA!)
- O operador marcou estas respostas como ruins. Não responda de forma parecida:

${lines.join('\n')}`;
}

function humanizeAction(action: UnitAction): string {
  const params = (action.actionParams as Record<string, unknown>) ?? {};
  switch (action.actionKind) {
    case 'add_tag': {
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      if (tags.length === 0) return 'aplicar uma tag relevante (não configurada)';
      if (tags.length === 1) return `chame aplicar_tag("${tags[0]}")`;
      const calls = tags.map((t) => `aplicar_tag("${t}")`).join(' e ');
      return `chame ${calls}`;
    }
    case 'transfer_with_permission': {
      const inc = params.includeSummary !== false;
      return [
        'pergunte ao cliente se ele aceita ser transferido pra um humano',
        '(ex: "Posso te conectar com a equipe?").',
        'Se ele aceitar, chame pausar_ia',
        inc ? 'e inclua um resumo breve do contexto pra o operador.' : '.',
      ].join(' ');
    }
    case 'transfer_without_permission': {
      const inc = params.includeSummary !== false;
      return [
        'chame pausar_ia imediatamente (sem pedir confirmação)',
        inc ? 'e deixe um resumo breve do contexto pra o operador.' : '.',
      ].join(' ');
    }
    default:
      return `executar ação "${action.actionKind}"`;
  }
}

function renderActions(actions: UnitAction[]): string {
  if (actions.length === 0) return '';
  const lines = actions.map((a, i) => {
    const cond = a.conditionDescription.trim();
    const act = humanizeAction(a);
    const notes = a.notes?.trim();
    const lineParts = [`${i + 1}. Quando ${cond}, ${act}`];
    if (notes) lineParts.push(`   Detalhes: ${notes}`);
    return lineParts.join('\n');
  });
  return `# AÇÕES CONFIGURADAS
- Use estas regras como guia pra detectar situações e disparar a ação correspondente
  via as tools disponíveis. Adapte a linguagem ao tom, mas mantenha a lógica.
- As ações são silenciosas — não anuncie ao cliente que aplicou uma tag ou transferiu.
  Exceção: transferência com permissão exige perguntar primeiro.

${lines.join('\n\n')}`;
}

function renderKnowledge(entries: Array<KnowledgeBaseEntry & { score: number }>): string {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (e, i) =>
      `${i + 1}. P: "${e.question.trim().slice(0, 200)}"\n   R: "${e.answer.trim().slice(0, 400)}"`,
  );
  return `# CONHECIMENTO RELEVANTE (use estas informações reais)
- Estas são respostas oficiais da empresa, pré-cadastradas. PREFIRA usar
  estas informações em vez de inventar. Adapte o tom mas mantenha os fatos.

${lines.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Composer principal.
// ---------------------------------------------------------------------------

export interface ComposeInput {
  unit: Unit;
  /** Texto vindo do AgentConfig (sobrescreve persona base se preenchido). */
  agentConfigPrompt?: string;
  /** Texto vindo das regras (renderWorkflowGuidance). */
  workflowText?: string;
  /** Templates já carregados — se ausente, NÃO faz lookup (use compose async). */
  templates?: MessageTemplate[];
  /** Mensagens flaggadas como exemplos a evitar. */
  flaggedExamples?: Array<{ content: string }>;
  /** Entradas da base de conhecimento já filtradas/scored. */
  knowledge?: Array<KnowledgeBaseEntry & { score: number }>;
  /** Regras "quando → faça" cadastradas na Unit. */
  actions?: UnitAction[];
}

export function composeSystemPrompt(input: ComposeInput): string {
  const {
    unit,
    agentConfigPrompt,
    workflowText,
    templates = [],
    flaggedExamples = [],
    knowledge = [],
    actions = [],
  } = input;

  // Bloco 1: persona base. Se o usuário escreveu um systemPrompt customizado,
  // ele aparece PRIMEIRO (tem prioridade sobre o auto-gerado).
  const customBase = (agentConfigPrompt && agentConfigPrompt.trim().length > 0
    ? agentConfigPrompt
    : unit.systemPrompt
  )?.trim();

  const blocks: string[] = [];

  if (customBase) {
    blocks.push(customBase);
  } else {
    // Sem texto custom — usa persona auto-gerada.
    blocks.push(renderPersona(unit));
  }

  // Fontes — 3 docs estruturados da aba Fontes vêm logo após a persona pra
  // que a IA tenha o contexto do negócio antes das regras operacionais.
  const sourcesBlock = renderSources(unit);
  if (sourcesBlock) blocks.push(sourcesBlock);

  blocks.push(renderRulesGlobal());

  const featureBlocks = [
    renderQualification(unit),
    renderHandoff(unit),
    renderPipelineIntents(unit),
    renderContactCollection(unit),
    renderWelcomeCoupon(unit),
    renderBusinessHours(unit),
    renderFollowUp(unit),
  ].filter((b) => b.trim().length > 0);

  if (featureBlocks.length > 0) {
    blocks.push('# COMPORTAMENTOS ATIVADOS');
    blocks.push(...featureBlocks);
  }

  const actionsBlock = renderActions(actions);
  if (actionsBlock) blocks.push(actionsBlock);

  const templatesBlock = renderTemplates(templates);
  if (templatesBlock) blocks.push(templatesBlock);

  const knowledgeBlock = renderKnowledge(knowledge);
  if (knowledgeBlock) blocks.push(knowledgeBlock);

  const flaggedBlock = renderFlaggedExamples(flaggedExamples);
  if (flaggedBlock) blocks.push(flaggedBlock);

  if (workflowText && workflowText.trim()) {
    blocks.push(workflowText.trim());
  }

  return blocks.join('\n\n');
}

/**
 * Async variant — busca templates + flaggedExamples + RAG do banco
 * automaticamente. Usar em runtime do agente (graph.ts).
 *
 * Se `userMessage` for passado, faz busca semântica na base de conhecimento
 * e injeta as top-3 mais relevantes no prompt. Sem userMessage, pula RAG.
 */
export async function composeSystemPromptForUnit(input: {
  unit: Unit;
  agentConfigPrompt?: string;
  workflowText?: string;
  userMessage?: string;
}): Promise<string> {
  const [templates, flagged, knowledge, actions] = await Promise.all([
    prisma.messageTemplate.findMany({
      where: { unitId: input.unit.id },
      orderBy: { name: 'asc' },
    }),
    prisma.message.findMany({
      where: {
        conversation: { unitId: input.unit.id },
        flagged: true,
        role: 'assistant',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { content: true },
    }),
    input.userMessage && input.unit.openaiApiKey
      ? searchKnowledge(input.unit, input.userMessage, { topK: 3, minScore: 0.25 }).catch(
          (err) => {
            logger.warn({ err, unitId: input.unit.id }, 'RAG search failed, sem KB no prompt');
            return [];
          },
        )
      : Promise.resolve([]),
    listEnabledActions(input.unit.id),
  ]);
  return composeSystemPrompt({
    ...input,
    templates,
    flaggedExamples: flagged,
    knowledge,
    actions,
  });
}

/**
 * Helper de preview pro front: mesma lógica do composer, mas só com a Unit
 * (sem agentConfig nem workflow). Útil pra mostrar o "preview" no wizard.
 */
export function previewComposedPrompt(unit: Unit): string {
  return composeSystemPrompt({ unit });
}
