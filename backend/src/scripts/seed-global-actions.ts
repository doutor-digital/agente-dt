// ============================================================================
// seed-global-actions.ts — Popula a tabela GlobalAction com as 4 regras
// padrão que valem pra todas as units.
//
// Idempotente: usa upsert por `conditionDescription` (não temos UNIQUE, então
// fazemos findFirst+create — se quiser editar regras existentes, mexa direto
// no painel).
//
// Uso:
//   pnpm tsx src/scripts/seed-global-actions.ts
// ============================================================================

import { prisma } from '../lib/prisma.js';

interface SeedGlobal {
  conditionDescription: string;
  actions: Array<{ kind: string; params: Record<string, unknown> }>;
  notes?: string;
  priority: number;
}

const SEEDS: SeedGlobal[] = [
  // 1. Acolher emergência / sofrimento mental — PRIORIDADE MÁXIMA.
  //    Vem primeiro: se a IA tiver que escolher uma regra global, esta é a
  //    primeira coisa que ela vê.
  {
    priority: 10,
    conditionDescription:
      'O paciente mencionar crise, ideação suicida, automutilação, depressão grave ou pedido de socorro emocional',
    actions: [
      {
        kind: 'respond_with_intent',
        params: {
          instruction:
            'Acolha com empatia e calma em 1-2 frases curtas. Sem julgamento, sem soluções rápidas, sem clichês ("vai passar"). Diga claramente que existe ajuda especializada disponível agora — o CVV (Centro de Valorização da Vida) atende 24 horas pelo 188 (gratuito) ou chat em cvv.org.br. Mencione que você vai conectar um humano da equipe pra acompanhar. NÃO faça diagnóstico, NÃO recomende remédio, NÃO minimize. Mantenha o tom humano e direto.',
        },
      },
      { kind: 'add_tag', params: { tags: ['emergencia-emocional', 'aguardando-humana'] } },
      { kind: 'transfer_without_permission', params: { includeSummary: true } },
    ],
    notes:
      'Regra global de segurança. Toda menção de crise emocional → acolhimento + CVV 188 + handoff imediato pra humano. NUNCA tente "resolver" sozinha.',
  },

  // 2. Paciente pede atendente humano — handoff cordial.
  {
    priority: 20,
    conditionDescription:
      'O paciente pedir explicitamente pra falar com um atendente humano (palavras como "humano", "atendente", "pessoa", "alguém da equipe", "operador", "real", "de verdade")',
    actions: [
      { kind: 'add_tag', params: { tags: ['aguardando-humana'] } },
      { kind: 'transfer_with_permission', params: { includeSummary: true } },
    ],
    notes:
      'Pergunte se ele aceita ser transferido ("Posso te conectar com a equipe?") antes de pausar. Se ele já mandou que quer humano direto/com urgência, transfira sem perguntar.',
  },

  // 3. Ofensa / agressão verbal — pausa pra defender o operador e o paciente.
  {
    priority: 30,
    conditionDescription:
      'O paciente xingar, ofender, agredir verbalmente, ameaçar ou usar linguagem hostil ('
      + 'palavrões direcionados, ameaças explícitas, racismo/preconceito, etc.)',
    actions: [
      { kind: 'add_tag', params: { tags: ['ofensa', 'aguardando-humana'] } },
      { kind: 'transfer_without_permission', params: { includeSummary: true } },
    ],
    notes:
      'NÃO responda à ofensa nem entre em discussão. Pause a IA, registre a tag pra o time decidir, e encerre cordialmente sem se desculpar pela ofensa do outro lado.',
  },

  // 5. Nome do lead obrigatório antes de mover etapa.
  //    Evita que cards anônimos ("WhatsApp Web", "Visitante", telefone) avancem
  //    no funil sem identificação. Se o paciente recusar 2x, IA grava
  //    "Lead sem nome" no título — a data DD/MM/YYYY é adicionada automaticamente
  //    pelo helper updateLeadTitleWithDate, usando lead.created_at.
  {
    priority: 50,
    conditionDescription:
      'Você está prestes a chamar mover_etapa MAS o paciente ainda não informou o nome dele (o título do card no Kommo ainda está genérico: "WhatsApp Web", "Visitante", apenas um número de telefone, ou qualquer placeholder do tipo)',
    actions: [
      {
        kind: 'respond_with_intent',
        params: {
          instruction:
            'ANTES de mover a etapa, peça o nome do paciente de forma calorosa numa frase só (ex: "Antes de seguir, como posso te chamar? 😊"). Só chame mover_etapa DEPOIS que o paciente disser o nome e você tiver chamado a tool que atualiza o título do card (atualizar_titulo_lead OU a tool de captura de nome com flag de título). Se o paciente recusar EXPLICITAMENTE duas vezes ("não quero dizer", "depois", "tanto faz", "não importa"), grave "Lead sem nome" como nome — o sistema acrescenta a data automaticamente — e então PROSSIGA normalmente com mover_etapa. Nunca avance o funil com card anônimo.',
        },
      },
    ],
    notes:
      'Trava de qualidade do funil. Garante que nenhum lead avance pra próxima etapa sem identificação mínima. Fallback "Lead sem nome DD/MM/YYYY" é aceitável após 2 recusas.',
  },

  // 4. Anti-diagnóstico — vale pra QUALQUER unidade de saúde.
  {
    priority: 40,
    conditionDescription:
      'O paciente pedir diagnóstico, prescrição de medicamento, recomendação de exercício, alongamento, gelo, calor, postura, ou qualquer orientação clínica específica',
    actions: [
      {
        kind: 'respond_with_intent',
        params: {
          instruction:
            'Explique em 1 frase amigável que esse tipo de avaliação precisa ser feita por um profissional presencialmente, porque cada caso é único e você não tem como ver o quadro completo por mensagem. Se ele insistir ou pedir alívio imediato, sugira agendamento e oriente a evitar esforço/automedicação até lá. NÃO dê palpite clínico, NÃO mencione remédio, NÃO recomende manobra.',
        },
      },
    ],
    notes:
      'Risco regulatório alto: IA dando palpite clínico = problema sério. Se o paciente insistir 3x, sobe pra handoff humano automaticamente (combine com regra da unit, se existir).',
  },
];

async function main() {
  console.log(`Semeando ${SEEDS.length} regras globais...`);
  let inserted = 0;
  let skipped = 0;
  for (const s of SEEDS) {
    const existing = await prisma.globalAction.findFirst({
      where: { conditionDescription: s.conditionDescription },
    });
    if (existing) {
      console.log(`  ⏭  já existe: "${s.conditionDescription.slice(0, 60)}..."`);
      skipped++;
      continue;
    }
    await prisma.globalAction.create({
      data: {
        conditionDescription: s.conditionDescription,
        actions: s.actions as unknown as object,
        notes: s.notes ?? null,
        priority: s.priority,
        enabled: true,
      },
    });
    console.log(`  ✓ inserida: "${s.conditionDescription.slice(0, 60)}..."`);
    inserted++;
  }
  console.log(`\nResumo: ${inserted} inseridas, ${skipped} já existiam.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
