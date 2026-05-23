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

import type {
  GlobalAction,
  KnowledgeBaseEntry,
  LeadFieldRule,
  LeadMemory,
  MessageTemplate,
  Unit,
  UnitAction,
} from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { searchKnowledge } from '../services/knowledge.service.js';
import {
  listEnabledActions,
  listEnabledGlobalActions,
} from '../services/actions.service.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import { getLeadMemory, type LeadMemoryFacts } from '../services/lead-memory.service.js';
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
  const emojiBlock = renderEmojiStyle(unit);
  if (emojiBlock) lines.push(emojiBlock);
  const greeting = unit.personaGreeting?.trim();
  if (greeting) {
    lines.push(`Saudação preferida (use quando for o primeiro contato): "${greeting}"`);
  }
  return lines.join('\n');
}

function renderEmojiStyle(unit: Unit): string {
  const palette = (unit.personaEmojis ?? []).filter((e) => e && e.trim().length > 0);
  if (palette.length === 0) return '';
  const freq = unit.personaEmojiFrequency ?? 'normal';
  const guide: Record<string, string> = {
    low: 'Use NO MÁXIMO 1 emoji por mensagem — só quando reforçar o tom.',
    normal: 'Use 1 a 2 emojis por mensagem, espalhados (saudação + ponto-chave).',
    high: 'Use 2 a 4 emojis por mensagem pra deixar bem caloroso. Varie pra não repetir.',
  };
  return [
    'Emojis: você TEM uma paleta autorizada e DEVE usar — respostas sem emoji ficam secas.',
    `Paleta: ${palette.join(' ')}`,
    guide[freq] ?? guide.normal,
    'Nunca use emojis fora dessa paleta. Posicione naturalmente, evite empilhar 3+ seguidos.',
  ].join('\n');
}

function renderResponseLength(length: string | null | undefined): string {
  switch (length) {
    case 'curta':
      return 'Tamanho: respostas MUITO curtas, 1 frase, ≤ 200 caracteres. Vá direto ao ponto.';
    case 'detalhada':
      return 'Tamanho: respostas detalhadas, parágrafos curtos. ≤ 480 caracteres no total — o WhatsApp não é email e o CRM trunca textos longos.';
    case 'normal':
    default:
      return 'Tamanho: respostas curtas, 1 a 3 frases, ≤ 240 caracteres no total. WhatsApp não é email e o CRM trunca textos longos.';
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
  if (!papel && !produtos && !negocio) return '';

  // Cabeçalho de PRIORIDADE — instrui a LLM a tratar as Fontes como
  // verdade absoluta. Sem isso a IA dilui a informação ao misturar com
  // conhecimento pré-treinado e pode inventar coisas que não estão lá.
  sections.push(
    [
      '# 📚 FONTES OFICIAIS DA CLÍNICA — PRIORIDADE MÁXIMA',
      'O que está nesta seção é a verdade absoluta sobre o negócio. RESPONDA',
      'sempre baseado APENAS nestas informações. Se a pergunta do paciente',
      'não tem resposta aqui (e nem na base de conhecimento abaixo), diga',
      'honestamente que vai checar com a equipe — NUNCA invente preços,',
      'horários, procedimentos, prazos ou políticas que não estejam escritos',
      'aqui. Isso vale acima de qualquer regra de tom ou estilo.',
    ].join('\n'),
  );
  if (papel) {
    sections.push(`## 📋 Papel e Fluxo da IA\n${papel}`);
  }
  if (produtos) {
    sections.push(`## 💼 Produtos e Serviços\n${produtos}`);
  }
  if (negocio) {
    sections.push(`## 🏢 Visão Geral do Negócio\n${negocio}`);
  }
  return sections.join('\n\n');
}

function renderRulesGlobal(): string {
  return `# REGRAS GERAIS DE TOM
- ANTI-ALUCINAÇÃO: nunca invente fatos sobre a clínica (preços, horários,
  procedimentos, prazos, políticas, médicos, especialidades, endereços).
  Use APENAS o que está nas Fontes Oficiais acima OU na Base de Conhecimento.
  Se a informação não está em nenhum dos dois, responda: "Vou confirmar isso
  com a equipe e te retorno, tá? 😊". Pequenas variações de tom OK; inventar fatos NÃO.
- Respostas curtas: 1 a 3 frases. WhatsApp não é email.
- NUNCA use as palavras técnicas: "lead", "ID", "tag", "etapa", "pipeline", "tool", "campo", "sistema", "erro", "API", "função".
- Se algo deu errado por trás (tool falhou), NÃO conte ao cliente. Responda como se tudo estivesse normal.
- Tool errors são telemetria interna que você ignora completamente na resposta visível ao cliente.
- TODA resposta sua DEVE terminar com uma pergunta de continuidade — uma pergunta
  curta e relevante que mantém a conversa fluindo. Exemplos: "Faz sentido?",
  "Quer que eu te explique mais?", "Pode me contar um pouco mais sobre isso?",
  "Te ajudo a marcar um horário agora?". Sem isso, a conversa morre.
- A pergunta final precisa ter sentido — NUNCA termine com um "?" isolado ou uma
  frase truncada. Releia antes de mandar.`;
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
    return `  - Cliente ${label} → chame mover_etapa({ statusId: ${statusId} })`;
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

function renderCollectName(unit: Unit): string {
  if (!unit.collectNameEnabled) return '';
  return `# COLETA DE NOME (PROATIVA)
- Esta é uma instrução de ALTA PRIORIDADE. Se você ainda NÃO souber o nome
  do paciente, sua PRIMEIRA mensagem nesta conversa OBRIGATORIAMENTE deve
  abrir com saudação calorosa + emoji + pergunta pelo nome. Não responda
  a qualquer outra coisa antes de ter feito essa pergunta.
- A saudação deve ser breve, simpática, com 1-2 emojis bonitos. Use 1 destes
  estilos como referência (varie palavras pra não soar robótico):
    • "Oiê! 😊✨ Que bom ter você por aqui! Pra começar, como posso te chamar?"
    • "Olá! 🌷 Seja muito bem-vindo(a) à clínica! Antes de continuar, qual seu nome?"
    • "Oi! 👋💜 Tudo bem? Pra te atender melhor, posso saber seu nome? 🙏"
- Assim que o paciente disser o nome, chame IMEDIATAMENTE
  atualizar_titulo_lead({ nome: "<Nome>" }) pra mudar o título do card no Kommo.
  Passe SOMENTE o nome — o sistema acrescenta automaticamente a data da
  conversa, gravando como "<Nome> DD/MM/YYYY" (ex: "João 20/05/2026").
  A chamada é silenciosa — NUNCA fale "atualizei seu cadastro" ou similar.
- REGRA RÍGIDA: você NÃO PODE responder com texto que use o nome do paciente
  ANTES de ter chamado atualizar_titulo_lead nesse mesmo turno. Sequência
  obrigatória: (1) chamar a tool com o nome, (2) aguardar resposta da tool,
  (3) só então redigir a resposta usando o nome. Se você responder texto
  primeiro, o título do card NÃO atualiza e o registro fica corrompido.
- Depois de obtido, USE o nome do paciente nas respostas seguintes (com
  moderação — 1 vez a cada 2-3 mensagens, pra não parecer forçado).
- Se o paciente insistir em não dizer o nome, deixe pra lá após 2 tentativas.`;
}

function renderCollectSource(unit: Unit): string {
  if (!unit.collectSourceEnabled) return '';
  const opts = (unit.collectSourceOptions ?? []).filter(Boolean);
  const optsLine =
    opts.length > 0
      ? `Cite 2 ou 3 opções dessas no exemplo, de forma natural: ${opts.join(', ')}.`
      : 'Pergunte aberto, sem sugerir opções fixas.';
  return `# COLETA DE ORIGEM (COMO CONHECEU)
- Em algum momento dos PRIMEIROS 2-3 turnos da conversa (depois do nome se
  estiver coletando nome também), pergunte de forma leve e curiosa por onde o
  paciente conheceu a clínica. Sempre com 1-2 emojis. Exemplos:
    • "Ah, antes que eu esqueça: por onde você nos conheceu? 🤔 (Instagram, indicação…)"
    • "Curiosidade nossa 🌸: como você chegou até a gente?"
    • "Pra fechar o quebra-gelo 🍃 — por onde nos descobriu?"
- ${optsLine}
- Faça UMA vez só na conversa. Se ele desconversar, deixa pra lá.
- Quando ele responder, chame aplicar_tag("Origem: <fonte>"), exemplo:
  aplicar_tag("Origem: Instagram"). Use exatamente o prefixo "Origem: " pra
  facilitar o filtro no Kommo. Tag silenciosa — NÃO mencione na resposta.`;
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

function humanizeActionStep(step: { kind: string; params: Record<string, unknown> }): string {
  const params = step.params ?? {};
  switch (step.kind) {
    case 'add_tag': {
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      if (tags.length === 0) return 'aplicar uma tag relevante (não configurada)';
      if (tags.length === 1) return `chame aplicar_tag({ tag: "${tags[0]}" })`;
      // Múltiplas tags numa única chamada — atômico no Kommo, mais barato.
      const tagsArr = tags.map((t) => `"${t}"`).join(', ');
      return `chame aplicar_tag({ tags: [${tagsArr}] }) — todas de uma vez (UMA chamada só, NÃO chame várias vezes)`;
    }
    case 'move_stage': {
      const statusId = typeof params.statusId === 'number' ? params.statusId : Number(params.statusId);
      const label = typeof params.statusLabel === 'string' ? params.statusLabel : null;
      if (!Number.isFinite(statusId) || statusId <= 0) {
        return 'mover o lead pra uma etapa (não configurada)';
      }
      const pipelineId = typeof params.pipelineId === 'number' ? params.pipelineId : undefined;
      const call = pipelineId
        ? `mover_etapa({ statusId: ${statusId}, pipelineId: ${pipelineId} })`
        : `mover_etapa({ statusId: ${statusId} })`;
      return label ? `chame ${call} — etapa "${label}"` : `chame ${call}`;
    }
    case 'transfer_with_permission': {
      const inc = params.includeSummary !== false;
      return [
        'pergunte ao cliente se ele aceita ser transferido pra um humano',
        '(ex: "Posso te conectar com a equipe?").',
        'Se ele aceitar:',
        inc
          ? '(1) PRIMEIRO chame resumir_lead_para_sdr({ leadId }) — gera resumo e grava em nota + campo custom; (2) DEPOIS chame pausar_ia. Sequência obrigatória nessa ordem; não pule o resumo.'
          : 'chame pausar_ia.',
      ].join(' ');
    }
    case 'transfer_without_permission': {
      const inc = params.includeSummary !== false;
      return inc
        ? '(1) PRIMEIRO chame resumir_lead_para_sdr({ leadId }) — gera resumo e grava em nota + campo custom; (2) DEPOIS chame pausar_ia imediatamente (sem pedir confirmação). Sequência obrigatória nessa ordem; não pule o resumo.'
        : 'chame pausar_ia imediatamente (sem pedir confirmação).';
    }
    case 'summarize_to_note': {
      const hint = typeof params.focusHint === 'string' && params.focusHint.trim()
        ? ` Foco: ${params.focusHint.trim()}.`
        : '';
      return `chame resumir_lead_para_sdr — gera um resumo do contexto e posta como NOTA INTERNA no Kommo pro SDR humano ver.${hint} A nota fica visível só pros operadores; o paciente não vê.`;
    }
    case 'send_message': {
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      if (!text) return 'enviar mensagem (texto não configurado)';
      return `ENVIE EXATAMENTE esta mensagem como sua resposta no turno corrente (reproduza palavra-por-palavra, sem reformular nem resumir; pode adicionar 1 emoji no fim se combinar com o tom):\n"""\n${text}\n"""`;
    }
    case 'respond_with_intent': {
      const instruction = typeof params.instruction === 'string' ? params.instruction.trim() : '';
      if (!instruction) return 'orientar resposta (orientação não configurada)';
      // Oposto do send_message: a IA NÃO copia literal. Reformula com palavras
      // próprias, respeitando o conteúdo/intenção e a lógica condicional da
      // orientação. O bloco em aspas duplas (não triplas) reduz a tendência
      // do LLM de reproduzir literal — sinal visual diferente do send_message.
      return [
        `SUA RESPOSTA NESTE TURNO DEVE SEGUIR A ORIENTAÇÃO ABAIXO. Use SUAS PRÓPRIAS PALAVRAS — NÃO copie literalmente. Respeite a intenção, o conteúdo e qualquer lógica condicional ("se X então Y") que a orientação trouxer. Mantenha o tom da persona configurada (não fique formal demais nem robótico):`,
        '',
        `Orientação: ${instruction}`,
      ].join('\n');
    }
    case 'create_task': {
      const text = typeof params.text === 'string' ? params.text.trim() : '';
      const deadlineMinutes =
        typeof params.deadlineMinutes === 'number' ? params.deadlineMinutes : 0;
      const userId =
        typeof params.responsibleUserId === 'number' ? params.responsibleUserId : null;
      const userName = typeof params.responsibleUserName === 'string' ? params.responsibleUserName : null;
      if (!text || !deadlineMinutes) return 'criar tarefa (não configurada)';
      const userPart = userId ? `, responsibleUserId: ${userId}` : '';
      const deadlineHuman = formatDeadline(deadlineMinutes);
      const userHuman = userName ? ` — atribuída a ${userName}` : '';
      return `chame criar_tarefa({ text: "${text}", deadlineMinutes: ${deadlineMinutes}${userPart} }) — cria tarefa pro SDR no Kommo com prazo de ${deadlineHuman}${userHuman}. Silencioso pro paciente.`;
    }
    case 'assign_responsible': {
      const userId = typeof params.userId === 'number' ? params.userId : null;
      const userName = typeof params.userName === 'string' ? params.userName : null;
      if (!userId) return 'atribuir responsável (não configurado)';
      const label = userName ? ` (${userName})` : '';
      return `chame atribuir_responsavel({ userId: ${userId} }) — transfere a propriedade do lead pro usuário Kommo${label}.`;
    }
    case 'remove_tag': {
      const tag = typeof params.tag === 'string' ? params.tag : '';
      if (!tag) return 'remover tag (não configurada)';
      return `chame remover_tag({ tag: "${tag}" }) — remove a tag "${tag}" do lead. Idempotente.`;
    }
    case 'set_lead_value': {
      const price = typeof params.price === 'number' ? params.price : Number(params.price);
      if (!Number.isFinite(price)) return 'definir valor (não configurado)';
      return `chame definir_valor_lead({ price: ${price} }) — define o valor (price) do lead em R$ ${price}.`;
    }
    case 'mark_lead_status': {
      const status = params.status === 'won' || params.status === 'lost' ? params.status : null;
      const lossReasonId =
        typeof params.lossReasonId === 'number' ? params.lossReasonId : null;
      const lossReasonLabel =
        typeof params.lossReasonLabel === 'string' ? params.lossReasonLabel : null;
      if (!status) return 'fechar lead (status não configurado)';
      if (status === 'won') {
        return `chame fechar_lead({ won: true }) — marca o lead como VENDA REALIZADA no Kommo.`;
      }
      const reasonPart = lossReasonId ? `, lossReasonId: ${lossReasonId}` : '';
      const reasonLabel = lossReasonLabel ? ` (motivo: ${lossReasonLabel})` : '';
      return `chame fechar_lead({ won: false${reasonPart} }) — marca o lead como VENDA PERDIDA${reasonLabel}.`;
    }
    case 'move_pipeline': {
      const pipelineId =
        typeof params.pipelineId === 'number' ? params.pipelineId : Number(params.pipelineId);
      const pipelineLabel = typeof params.pipelineLabel === 'string' ? params.pipelineLabel : null;
      const statusId = typeof params.statusId === 'number' ? params.statusId : null;
      const statusLabel = typeof params.statusLabel === 'string' ? params.statusLabel : null;
      if (!Number.isFinite(pipelineId) || pipelineId <= 0) return 'mover funil (não configurado)';
      const statusPart = statusId ? `, statusId: ${statusId}` : '';
      const label = [pipelineLabel, statusLabel].filter(Boolean).join(' → ');
      const labelHuman = label ? ` — funil "${label}"` : '';
      return `chame mover_funil({ pipelineId: ${pipelineId}${statusPart} }) — move o lead pro funil destino${labelHuman}.`;
    }
    case 'pause_ai': {
      const stageId =
        typeof params.moveToStageId === 'number' ? params.moveToStageId : null;
      const pipelineId =
        typeof params.moveToPipelineId === 'number' ? params.moveToPipelineId : null;
      const stageLabel =
        typeof params.moveToStageLabel === 'string' ? params.moveToStageLabel : null;
      const parts = ['chame pausar_ia — desliga a IA pra esse lead, Salesbot do Kommo para de disparar'];
      if (stageId && stageId > 0) {
        const pipelinePart = pipelineId ? `, pipelineId: ${pipelineId}` : '';
        const labelHuman = stageLabel ? ` (etapa "${stageLabel}")` : '';
        parts.push(`e DEPOIS chame mover_etapa({ statusId: ${stageId}${pipelinePart} })${labelHuman} — pra o SDR encontrar o lead no funil`);
      }
      parts.push('Ação silenciosa — não anuncie ao paciente que a IA foi pausada.');
      return parts.join('. ') + '.';
    }
    case 'pause_in_stages': {
      // Não vai pro prompt — é um GUARD avaliado no webhook controller ANTES
      // de invocar o agent. Se a regra cair aqui no render é porque está
      // misturada com outras ações; mostramos uma linha curta só pra registro.
      const stages = Array.isArray(params.stages) ? (params.stages as Array<{ statusLabel?: string; statusId: number }>) : [];
      if (stages.length === 0) return '(guard) pausar IA em etapas: nenhuma configurada';
      const labels = stages
        .map((s) => s.statusLabel || `etapa ${s.statusId}`)
        .join(', ');
      return `(guard automático — não requer ação sua) IA é pausada quando o lead está em: ${labels}`;
    }
    default:
      return `executar ação "${step.kind}"`;
  }
}

/** Formata minutos como texto legível pro prompt. */
function formatDeadline(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hora' : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? '1 dia' : `${days} dias`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? '1 semana' : `${weeks} semanas`;
}

/** Para uma UnitAction, devolve a string descrevendo TODAS as ações dela. */
/**
 * Shape mínimo aceito por humanizeAction / renderActions / renderGlobalActions.
 * Cobre tanto UnitAction (com fallback legado actionKind/actionParams) quanto
 * GlobalAction (só o array `actions` novo).
 */
interface ActionLike {
  actions: unknown;
  actionKind?: string;
  actionParams?: unknown;
  conditionDescription: string;
  notes?: string | null;
}

function humanizeAction(action: ActionLike): string {
  // Lê o array novo OU cai pra par legado (só UnitAction tem isso).
  const arr = Array.isArray(action.actions) ? (action.actions as Array<{ kind: string; params: Record<string, unknown> }>) : [];
  const steps =
    arr.length > 0
      ? arr
      : action.actionKind
        ? [{ kind: action.actionKind, params: (action.actionParams as Record<string, unknown>) ?? {} }]
        : [];
  if (steps.length === 0) return 'sem ação configurada';
  if (steps.length === 1) return humanizeActionStep(steps[0]);
  // Multi-ação: lista numerada inline.
  const parts = steps.map((s, i) => `(${i + 1}) ${humanizeActionStep(s)}`);
  return `dispare TODAS as ações abaixo, em ordem: ${parts.join('; ')}`;
}

/**
 * Determina se uma regra é puramente "guard" (só steps que NÃO vão pro prompt
 * do LLM — caso de pause_in_stages, que é avaliado pelo webhook controller).
 * Regras 100% guard são omitidas do prompt pra economizar tokens.
 */
function isPureGuardRule(action: ActionLike): boolean {
  const arr = Array.isArray(action.actions) ? (action.actions as Array<{ kind: string }>) : [];
  if (arr.length === 0) return false;
  return arr.every((s) => s.kind === 'pause_in_stages');
}

function renderActions(actions: UnitAction[]): string {
  const visible = actions.filter((a) => !isPureGuardRule(a));
  if (visible.length === 0) return '';
  const lines = visible.map((a, i) => {
    const cond = a.conditionDescription.trim();
    const act = humanizeAction(a);
    const notes = a.notes?.trim();
    const lineParts = [`${i + 1}. Quando ${cond}, ${act}`];
    if (notes) lineParts.push(`   Detalhes: ${notes}`);
    return lineParts.join('\n');
  });
  return `# AÇÕES CONFIGURADAS
- Use estas regras como guia pra detectar situações e disparar TODAS as ações
  correspondentes via as tools disponíveis. Cada regra pode ter múltiplas
  ações que devem ser executadas juntas no mesmo turno.
- As ações são silenciosas — não anuncie ao cliente que aplicou uma tag,
  mudou de etapa, transferiu ou gerou resumo interno.
  Exceção: transferência com permissão exige perguntar primeiro.

${lines.join('\n\n')}`;
}

/**
 * Renderiza regras globais (`GlobalAction[]`). Vem ANTES das regras da unit no
 * prompt, com header próprio destacado pra IA dar a elas peso máximo —
 * tipicamente cobrem segurança/compliance (handoff humano, emergência médica,
 * anti-diagnóstico, ofensa).
 *
 * Em caso de conflito com regras da unit, as globais ganham (são mais
 * conservadoras: param a IA em vez de tentar virar a conversa).
 */
function renderGlobalActions(actions: GlobalAction[]): string {
  const visible = actions.filter((a) => !isPureGuardRule(a));
  if (visible.length === 0) return '';
  const lines = visible.map((a, i) => {
    const cond = a.conditionDescription.trim();
    const act = humanizeAction(a);
    const notes = a.notes?.trim();
    const lineParts = [`${i + 1}. Quando ${cond}, ${act}`];
    if (notes) lineParts.push(`   Detalhes: ${notes}`);
    return lineParts.join('\n');
  });
  return `# 🌐 REGRAS GLOBAIS DA PLATAFORMA (prioridade máxima)
- Estas regras valem pra TODAS as unidades. Têm PRIORIDADE sobre as ações
  específicas da unit — quando uma regra global bate, ela é não-negociável.
- Aplica TODAS as ações da regra quando a condição bater, em silêncio.
- Em conflito com regras da unit: a global ganha (são mais conservadoras —
  segurança e compliance).

${lines.join('\n\n')}`;
}

function renderLeadFieldRules(rules: LeadFieldRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r, i) => {
    const enums = (r.kommoFieldEnums as Array<{ id: number; value: string }> | null) ?? [];
    const enumsLine =
      enums.length > 0 ? `\n   Opções permitidas: ${enums.map((e) => `"${e.value}"`).join(', ')}` : '';
    const hintLine = r.valueHint?.trim() ? `\n   Formato: ${r.valueHint.trim()}` : '';
    const examplesLine =
      r.examples.length > 0
        ? `\n   Gatilhos: ${r.examples.slice(0, 5).map((e) => `"${e}"`).join('; ')}`
        : '';
    return `${i + 1}. ${r.toolName} → grava em "${r.kommoFieldName}" (${r.kommoFieldType})
   Quando usar: ${r.instruction.trim()}${hintLine}${enumsLine}${examplesLine}`;
  });
  return `# CAPTURA DE DADOS
- As tools abaixo gravam informações estruturadas no card do paciente no Kommo.
- Chame em SILÊNCIO assim que detectar a informação — NÃO anuncie ("anotei seu...").
- Cada tool é idempotente; chamar duas vezes com o mesmo valor não duplica.

${lines.join('\n\n')}`;
}

/**
 * Renderiza a memória de longo prazo do lead — summary + facts.
 *
 * Posicionado cedo no prompt (antes das ações) pra ancorar respostas em
 * contexto histórico do paciente. Pequeno e barato — atualizado em background
 * pelo lead-memory.service, então a leitura aqui é só 1 query indexada.
 */
function renderLeadMemory(mem: LeadMemory | null): string {
  if (!mem) return '';
  const summary = (mem.summary ?? '').trim();
  const facts = (mem.facts as LeadMemoryFacts | null) ?? {};
  const factsEntries = Object.entries(facts).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!summary && factsEntries.length === 0) return '';

  const lines: string[] = ['# 🧠 MEMÓRIA DO PACIENTE (longo prazo)'];
  lines.push('- Dados consolidados de conversas anteriores. Use pra personalizar SEM citar explicitamente que tem registro.');
  lines.push('- Se houver conflito com a mensagem atual, dê preferência ao que o paciente está dizendo AGORA.');
  if (summary) {
    lines.push('');
    lines.push(`**Resumo:** ${summary}`);
  }
  if (factsEntries.length > 0) {
    lines.push('');
    lines.push('**Dados estruturados:**');
    for (const [k, v] of factsEntries) {
      lines.push(`  - ${k}: ${String(v)}`);
    }
  }
  return lines.join('\n');
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
  /** Templates já carregados — se ausente, NÃO faz lookup (use compose async). */
  templates?: MessageTemplate[];
  /** Mensagens flaggadas como exemplos a evitar. */
  flaggedExamples?: Array<{ content: string }>;
  /** Entradas da base de conhecimento já filtradas/scored. */
  knowledge?: Array<KnowledgeBaseEntry & { score: number }>;
  /** Regras "quando → faça" cadastradas na Unit. */
  actions?: UnitAction[];
  /** Regras "quando → faça" GLOBAIS (valem pra todas as units). */
  globalActions?: GlobalAction[];
  /** Regras de captura de dados (LeadFieldRule) — viram tools dinâmicas. */
  leadFieldRules?: LeadFieldRule[];
  /** Memória de longo prazo do lead. Vai pro prompt como bloco "🧠 MEMÓRIA". */
  leadMemory?: LeadMemory | null;
  /**
   * leadId numérico do Kommo para este turno. Injetado no system prompt como
   * "CONTEXTO DA CONVERSA" pra IA usar nas tool calls. Sem isso, a IA passa
   * `leadId: 0` ou similar e as tools falham silenciosamente.
   */
  leadId?: number;
  /** Este é o PRIMEIRO turno do paciente? (1 humana, 0 IA). */
  isFirstTurn?: boolean;
}

function renderFirstTurnBoost(unit: Unit, isFirstTurn: boolean): string {
  if (!isFirstTurn) return '';
  const collectName = unit.collectNameEnabled;
  const collectSource = unit.collectSourceEnabled;
  const palette = (unit.personaEmojis ?? []).filter(Boolean);
  const emojisHint =
    palette.length > 0
      ? `Use 2-3 emojis da sua paleta (${palette.slice(0, 8).join(' ')}).`
      : 'Use 2-3 emojis acolhedores (😊 🌷 ✨ 🙏 👋).';

  const lines: string[] = [
    '# 🚨 TURNO 1 — PRIMEIRA MENSAGEM DA CONVERSA (PRIORIDADE MÁXIMA)',
    'Esta é a sua PRIMEIRA resposta ao paciente. NUNCA responda só "Olá!" ou',
    '"Oi!" sozinho. Respostas curtas/secas estão TERMINANTEMENTE PROIBIDAS aqui.',
    '',
    'Sua resposta DEVE conter, nesta ordem:',
    '  1. Saudação calorosa + emoji (não só "olá")',
    '  2. Apresentação rápida (você é da clínica X)',
  ];
  let step = 3;
  if (collectName) {
    lines.push(`  ${step}. Pergunta natural pelo nome do paciente`);
    step++;
  }
  if (collectSource) {
    lines.push(`  ${step}. (opcional) Pode já encaixar de leve "por onde nos conheceu?"`);
    step++;
  }
  lines.push(`  ${step}. SE o paciente já trouxe um problema (dor, dúvida), reconheça com empatia ANTES de pedir o nome.`);
  lines.push('');
  lines.push(emojisHint);
  lines.push('Tamanho-alvo: 2 a 4 frases. Nem curto demais ("Olá!"), nem texto-livro.');
  lines.push('');
  lines.push('Exemplo de resposta BOA (adapte ao tom da sua clínica, NÃO copie literal):');
  lines.push(
    `  "Oiê! 🌷 Que bom te receber por aqui na ${unit.personaCompanyName ?? 'clínica'}! ` +
      'Antes de tudo, como posso te chamar? 😊"',
  );
  lines.push('');
  lines.push('Exemplo de resposta RUIM (NUNCA faça assim):');
  lines.push('  ❌ "Olá!"');
  lines.push('  ❌ "Oi! Como posso ajudar?"');
  return lines.join('\n');
}

export function composeSystemPrompt(input: ComposeInput): string {
  const {
    unit,
    agentConfigPrompt,
    templates = [],
    flaggedExamples = [],
    knowledge = [],
    actions = [],
    globalActions = [],
    leadFieldRules = [],
    leadMemory = null,
    isFirstTurn = false,
    leadId,
  } = input;

  // ORDEM DOS BLOCOS — pensada pra qualidade da resposta:
  //   1. Persona auto-gerada do Wizard (quem a IA é, como fala, paleta de emoji).
  //   2. FONTES OFICIAIS — verdade absoluta sobre o negócio, vêm logo cedo pra
  //      a LLM ancorar antes das regras de tom.
  //   3. customBase opcional do "Avançado" — instrução extra do super-admin,
  //      vem DEPOIS das Fontes pra nunca sobrescrever (antes da refatoração,
  //      podia sobrescrever a persona e diluía as Fontes).
  //   4. Regras globais (anti-alucinação, tom, fechamento com pergunta).
  //   5. Feature blocks do Wizard (coleta de nome, qualificação, etc).
  const customBase = (agentConfigPrompt && agentConfigPrompt.trim().length > 0
    ? agentConfigPrompt
    : unit.systemPrompt
  )?.trim();

  const blocks: string[] = [];

  // SEMPRE inclui a persona auto-gerada (não é mais opcional). O customBase
  // virou aditivo, não substituto — assim as Fontes nunca ficam órfãs.
  blocks.push(renderPersona(unit));

  // Fontes oficiais vêm BEM CEDO. São a verdade do negócio.
  const sourcesBlock = renderSources(unit);
  if (sourcesBlock) blocks.push(sourcesBlock);

  // Texto avançado opcional — adiciona, não sobrescreve.
  if (customBase) {
    blocks.push(`# 🔧 INSTRUÇÕES EXTRAS (avançado)\n${customBase}`);
  }

  blocks.push(renderRulesGlobal());

  const featureBlocks = [
    // Coleta de nome/origem PRIMEIRO — a IA precisa saudar com isso antes de
    // qualquer outra coisa quando ativados.
    renderCollectName(unit),
    renderCollectSource(unit),
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

  // MEMÓRIA DO PACIENTE — vem cedo (antes das Ações) pra IA ancorar resposta
  // em contexto histórico. Só carrega/renderiza se houver registro.
  const memoryBlock = renderLeadMemory(leadMemory);
  if (memoryBlock) blocks.push(memoryBlock);

  // CONTEXTO DA CONVERSA — vai ANTES das Ações pra IA ler o leadId real e usar
  // nas tool calls. Sem isso, ela passa `leadId: 0` literalmente (a palavra
  // "leadId" aparece nos textos de orientação das ações como placeholder).
  if (leadId && Number.isFinite(leadId) && leadId > 0) {
    blocks.push(
      [
        '# 🔑 CONTEXTO DA CONVERSA',
        `- leadId desta conversa: **${leadId}**`,
        '- Ao chamar QUALQUER tool, use ESTE número EXATAMENTE como o argumento `leadId`.',
        '- NUNCA passe 0, NUNCA passe a string "leadId", NUNCA invente outro número.',
        `- Exemplo correto: aplicar_tag({ leadId: ${leadId}, tag: "..." }).`,
      ].join('\n'),
    );
  }

  // Globais antes — peso semântico maior e cobrem segurança/compliance.
  const globalActionsBlock = renderGlobalActions(globalActions);
  if (globalActionsBlock) blocks.push(globalActionsBlock);

  const actionsBlock = renderActions(actions);
  if (actionsBlock) blocks.push(actionsBlock);

  const leadFieldsBlock = renderLeadFieldRules(leadFieldRules);
  if (leadFieldsBlock) blocks.push(leadFieldsBlock);

  const templatesBlock = renderTemplates(templates);
  if (templatesBlock) blocks.push(templatesBlock);

  const knowledgeBlock = renderKnowledge(knowledge);
  if (knowledgeBlock) blocks.push(knowledgeBlock);

  const flaggedBlock = renderFlaggedExamples(flaggedExamples);
  if (flaggedBlock) blocks.push(flaggedBlock);

  // Boost de primeiro turno vai POR ÚLTIMO — instruções no fim do prompt têm
  // mais influência (efeito "recência") nos LLMs atuais.
  const firstTurnBlock = renderFirstTurnBoost(unit, isFirstTurn);
  if (firstTurnBlock) blocks.push(firstTurnBlock);

  return blocks.join('\n\n');
}

/**
 * Heurística: mensagem é "trivial" (saudação, ack curto) e RAG não vai
 * trazer nada útil mesmo? Pulamos o embedding (economiza ~500-800ms).
 *
 * Critérios (qualquer um basta):
 *   - texto ≤ 18 chars sem ponto de interrogação
 *   - bate com regex de saudação/ack comum
 *
 * Conservador: se NÃO bater, faz RAG normalmente — preferimos pagar o custo
 * a perder uma resposta relevante.
 */
function isTrivialUserMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized.includes('?')) return false; // pergunta → vale RAG
  if (normalized.length <= 18) return true;
  return /^(oi|ol[áa]|alo|hi|hello|bom dia|boa tarde|boa noite|tudo bem|td bem|obrigad[oa]|ok|valeu|tks|thanks|👋|🙏|😊)[\s.!?,]*$/i.test(
    normalized,
  );
}

/**
 * Async variant — busca templates + flaggedExamples + RAG do banco
 * automaticamente. Usar em runtime do agente (graph.ts).
 *
 * Se `userMessage` for passado, faz busca semântica na base de conhecimento
 * e injeta as top-3 mais relevantes no prompt. Sem userMessage, pula RAG.
 * Mensagens triviais (saudações, "ok", "obrigado") também pulam — embedding
 * é caro e não vai casar com FAQ mesmo.
 */
export async function composeSystemPromptForUnit(input: {
  unit: Unit;
  agentConfigPrompt?: string;
  userMessage?: string;
  isFirstTurn?: boolean;
  /** leadId do Kommo — injetado no bloco "CONTEXTO DA CONVERSA" pras tools. */
  leadId?: number;
  /**
   * Quando true, omite as regras de captura de dados (LeadFieldRule) do
   * prompt. Usado pelo Playground — sandbox não registra as tools `salvar_*`
   * dinâmicas, então sem isso a IA acabaria tentando chamar tool inexistente.
   */
  excludeLeadFieldRules?: boolean;
}): Promise<string> {
  const shouldRunRag =
    !!input.userMessage &&
    !!input.unit.openaiApiKey &&
    !isTrivialUserMessage(input.userMessage);

  const [templates, flagged, knowledge, actions, globalActions, leadFieldRules, leadMemory] = await Promise.all([
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
    shouldRunRag
      ? searchKnowledge(input.unit, input.userMessage!, { topK: 3, minScore: 0.25 }).catch(
          (err) => {
            logger.warn({ err, unitId: input.unit.id }, 'RAG search failed, sem KB no prompt');
            return [];
          },
        )
      : Promise.resolve([]),
    listEnabledActions(input.unit.id),
    listEnabledGlobalActions().catch((err) => {
      // Se a tabela GlobalAction ainda não foi migrada, não derruba o prompt.
      logger.warn({ err }, 'listEnabledGlobalActions falhou — seguindo sem regras globais');
      return [];
    }),
    input.excludeLeadFieldRules
      ? Promise.resolve([])
      : listEnabledLeadFieldRules(input.unit.id),
    input.leadId
      ? getLeadMemory(input.unit.id, input.leadId).catch((err) => {
          // Tabela pode não existir ainda em ambiente não-migrado.
          logger.warn({ err, leadId: input.leadId }, 'getLeadMemory falhou — sem memória no prompt');
          return null;
        })
      : Promise.resolve(null),
  ]);
  return composeSystemPrompt({
    ...input,
    templates,
    flaggedExamples: flagged,
    knowledge,
    actions,
    globalActions,
    leadFieldRules,
    leadMemory,
  });
}

/**
 * Helper de preview pro front: mesma lógica do composer, mas só com a Unit
 * (sem agentConfig nem workflow). Útil pra mostrar o "preview" no wizard.
 */
export function previewComposedPrompt(unit: Unit): string {
  return composeSystemPrompt({ unit });
}
