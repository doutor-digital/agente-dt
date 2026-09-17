/**
 * Cria a unidade Doutor Hérnia Mossoró no banco do agente.
 *
 * DIFERENÇA DOS replicate-* ANTERIORES: nada de id chumbado. Os ids de campo e
 * de etapa são resolvidos PELO NOME, lidos da conta de destino no momento em que
 * o script roda. Id de campo e de etapa é POR CONTA no Kommo, e copiar do script
 * anterior já deixou 5 unidades apontando para o funil da Serra e 19 com o campo
 * de resposta de outra conta — falha silenciosa, porque o Kommo devolve 404 e o
 * atendimento segue como se nada fosse.
 *
 * Mossoró é a primeira unidade que nasce COM a ficha da clínica respondida
 * (17/09/2026), então não herda placeholder nenhum: chave Pix, valores, endereço
 * e horários entram com o dado real, conferido contra o print do banco.
 *
 * Rodar em seco primeiro:  SECO=1 npx tsx src/scripts/replicate-mossoro.ts
 */
import { prisma } from '../lib/prisma.js';

const SRC_SLUG = process.env.MOSSORO_SRC_SLUG || 'doutor-hernia-maraba';
const DST_SLUG = 'doutor-hernia-mossoro';
const DST_NAME = 'Doutor Hérnia Mossoró';
const KOMMO_SUBDOMAIN = 'doutorherniamossoro';
const SECO = process.env.SECO === '1';

/** Ficha da unidade, respondida pela clínica em 17/09/2026. */
const FICHA = {
  pixKey: '56.267.421/0001-38',
  pixHolder: 'R F de Vasconcelos Ltda',
  precoAntecipado: 200,
  precoNoDia: 220,
  endereco: 'Rua Raimundo Leão de Moura, 18 — Nova Betânia, Mossoró/RN, CEP 59611-320',
  maps: 'https://share.google/PLBWdjRCTWBIMn65v',
  // Seg–qui 07:30–19:30, sexta até 17:00, sem sábado, sem almoço.
  agendaInicio: '07:30',
  agendaFim: '19:30',
  diasDaSemana: [1, 2, 3, 4, 5],
  horarioPorDia: { '5': { start: '07:30', end: '17:00' } },
  slotMinutos: 60,
};

/** Nome exato do campo no Kommo → para onde vai no banco. */
const CAMPOS_POR_NOME = {
  kommoReplyFieldId: 'Resposta da IA',
  kommoPausedFieldId: 'Pausar IA',
} as const;

/** Etapas do COMERCIAL que a IA pode ver, pelo nome. */
const ETAPAS_PERMITIDAS = [
  'Incoming leads',
  'EM QUALIFICAÇÃO',
  'EM ESPERA',
  'AGENDADO',
  'NÃO COMPARECEU',
  'COMPARECEU',
  'EM NEGOCIAÇÃO',
  'RETORNO PÓS-TRATAMENTO',
];

/** Para onde cada move_stage da unidade-fonte deve apontar, pelo NOME da etapa. */
const MOVE_STAGE_POR_NOME: Record<string, string> = {
  'EM QUALIFICAÇÃO': 'EM QUALIFICAÇÃO',
  'EM ESPERA': 'EM ESPERA',
  AGENDADO: 'AGENDADO',
  COMPARECEU: 'COMPARECEU',
  'NÃO COMPARECEU': 'NÃO COMPARECEU',
  'EM NEGOCIAÇÃO': 'EM NEGOCIAÇÃO',
  'RETORNO PÓS-TRATAMENTO': 'RETORNO PÓS-TRATAMENTO',
};

const NAO_COPIAR = new Set<string>([
  'id', 'slug', 'name', 'createdAt', 'updatedAt',
  'kommoSubdomain', 'kommoAccessToken', 'kommoWidgetSecret', 'kommoSalesbotId',
  'kommoReplyFieldId', 'kommoPausedFieldId', 'kommoCommentReplyFieldId',
  // Id de campo é POR CONTA. Estes três já foram parar na conta errada.
  'summaryCustomFieldId', 'igReplyFieldId', 'fbReplyFieldId',
  'kommoWonStatusIds', 'kommoAllowedStatusIds', 'pipelineIntents',
  'kommoWidgetReplyEnabled', 'kommoSalesbotExecuteEnabled',
  'llmProvider', 'anthropicApiKey', 'openaiApiKey', 'openaiAdminKey',
  'openaiAssistantId', 'googleApiKey',
  'metaAccessToken', 'metaAppSecret', 'metaVerifyToken',
  'igAccessToken', 'igAppSecret', 'igVerifyToken',
  'fbAccessToken', 'fbAppSecret', 'fbVerifyToken',
  'spineEnabled', 'spineBaseUrl', 'spineToken',
  'reminderEnabled', 'reminderSalesbotId', 'reactivationEnabled',
  // Dado de clínica NUNCA herda de outra unidade.
  'clinicAddress', 'clinicMapUrl', 'clinicPhotoDriveUuid', 'clinicPhotoDriveVersion',
  'pixKey', 'pixHolder',
]);

interface CampoKommo { id: number; name: string }
interface StatusKommo { id: number; name: string }

async function kommo<T>(caminho: string, token: string): Promise<T> {
  const r = await fetch(`https://${KOMMO_SUBDOMAIN}.kommo.com${caminho}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Kommo ${caminho} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Normaliza para casar nome apesar de acento, caixa e espaço sobrando. */
const chave = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

async function lerContaDeDestino(token: string) {
  const campos = await kommo<{ _embedded: { custom_fields: CampoKommo[] } }>(
    '/api/v4/leads/custom_fields?limit=250',
    token,
  );
  const porNome = new Map(campos._embedded.custom_fields.map((c) => [chave(c.name), c.id]));

  const ids: Record<string, number> = {};
  for (const [destino, nome] of Object.entries(CAMPOS_POR_NOME)) {
    const id = porNome.get(chave(nome));
    if (!id) throw new Error(`campo "${nome}" não existe na conta ${KOMMO_SUBDOMAIN}`);
    ids[destino] = id;
    console.log(`   campo "${nome}" → ${id}`);
  }

  const funis = await kommo<{
    _embedded: { pipelines: Array<{ id: number; name: string; is_main: boolean; _embedded: { statuses: StatusKommo[] } }> };
  }>('/api/v4/leads/pipelines', token);

  const comercial =
    funis._embedded.pipelines.find((p) => chave(p.name) === 'comercial') ??
    funis._embedded.pipelines.find((p) => p.is_main);
  if (!comercial) throw new Error('funil COMERCIAL não encontrado');

  const etapaPorNome = new Map(comercial._embedded.statuses.map((s) => [chave(s.name), s.id]));
  const permitidas: number[] = [];
  for (const nome of ETAPAS_PERMITIDAS) {
    const id = etapaPorNome.get(chave(nome));
    if (id) permitidas.push(id);
    else console.warn(`   ! etapa "${nome}" não existe em ${comercial.name} — ignorada`);
  }
  console.log(`   funil COMERCIAL → ${comercial.id} (${permitidas.length} etapas permitidas)`);

  return { ids, pipelineId: comercial.id, etapaPorNome };
}

type Passo = { kind?: string; params?: Record<string, unknown> };

/**
 * Reaponta os move_stage da unidade-fonte pelo NOME da etapa de origem.
 * A fonte guarda `statusLabel` justamente para isto; sem ele, o passo é deixado
 * como está e reportado — nunca adivinhado.
 */
function remapear(
  passos: Passo[],
  pipelineId: number,
  etapaPorNome: Map<string, number>,
): { passos: Passo[]; trocados: number; semMapa: string[] } {
  let trocados = 0;
  const semMapa: string[] = [];
  const saida = passos.map((p) => {
    if (p.kind !== 'move_stage') return p;
    const rotulo = String(p.params?.statusLabel ?? '');
    const alvoNome = MOVE_STAGE_POR_NOME[rotulo] ?? rotulo;
    const id = etapaPorNome.get(chave(alvoNome));
    // 143 (PERDIDO) e 142 (GANHO) são ids nativos, iguais em toda conta.
    if (!id) {
      const origem = Number(p.params?.statusId);
      if (origem === 142 || origem === 143) {
        trocados += 1;
        return { ...p, params: { ...p.params, statusId: origem, pipelineId } };
      }
      semMapa.push(rotulo || `statusId ${p.params?.statusId}`);
      return p;
    }
    trocados += 1;
    return { ...p, params: { ...p.params, statusId: id, pipelineId, statusLabel: alvoNome } };
  });
  return { passos: saida, trocados, semMapa };
}

/**
 * Troca a cidade da unidade-fonte e grava os valores REAIS da ficha.
 *
 * NADA de `\b` depois de letra acentuada: em JavaScript `á` não conta como
 * caractere de palavra, então `/\bMarabá\b/` NÃO casa com "Marabá " — e foi
 * exatamente assim que a cidade de origem sobrou no prompt de Mossoró na
 * primeira rodada (17/09/2026). Nome de cidade é substring segura; casa direto.
 */
function adaptarTexto(texto: string): string {
  return texto
    .replace(/Doutor Hérnia Marabá/g, DST_NAME)
    .replace(/unidade Marabá/g, 'unidade Mossoró')
    .replace(/Marabá/g, 'Mossoró')
    .replace(/Maraba/g, 'Mossoro')
    .replace(/Pará/g, 'Rio Grande do Norte')
    .replace(/\bPA\b/g, 'RN')
    .replace(/R\$ ?350/g, `R$ ${FICHA.precoNoDia}`)
    .replace(/R\$ ?2[05]0/g, `R$ ${FICHA.precoAntecipado}`);
}

/**
 * O que a clonagem NÃO resolve: `source_negocio` carrega a realidade
 * OPERACIONAL da unidade-fonte — horário, política de reserva, WhatsApp e
 * Instagram. Em Mossoró isso trouxe o telefone e o @ de Marabá, o horário de
 * sábado que Mossoró não tem, e "a vaga é garantida com o pagamento", que é
 * regra de Marabá e não de Mossoró. Trocar o nome da cidade não conserta nada
 * disso. Por isso este bloco é REESCRITO a partir da ficha, nunca herdado.
 */
const NEGOCIO = `Jornada: paciente chega (geralmente por anúncio de dor nas costas/hérnia) → Sofia acolhe e coleta o nome → entende a queixa e qualifica (é caso de coluna? aceita particular?) → constrói o valor da consulta → consulta os horários REAIS da agenda da clínica → oferece 2 ou 3 opções → AGENDA a consulta e move o lead para a etapa de agendado.

Atendimento PARTICULAR. A vaga NÃO depende de pagamento antecipado: a clínica segura o horário e o paciente pode pagar depois. O pagamento antecipado por Pix vale o valor menor e pode ser feito até a MANHÃ DO DIA da consulta — depois disso vale o valor do dia.

A própria Sofia envia a chave Pix da unidade quando o paciente pede; ela nunca inventa chave, endereço nem forma de pagamento — usa só o que está nas Fontes Oficiais.

HORÁRIOS: segunda a quinta das 07:30 às 19:30 e sexta das 07:30 às 17:00, sem fechar para almoço. NÃO atende no sábado nem no domingo. Cada consulta ocupa 1 hora na agenda.

PROFISSIONAIS: Dra. Victória Nunes atende das 07:30 às 13:30 e Dr. Everton Kathaiamy das 13:30 às 19:30 (na sexta até as 17:00).

PAGAMENTO: no dia, aceita dinheiro, cartão de débito, cartão de crédito em até 2x sem juros e Pix. NÃO aceita convênio nem plano de saúde — atendimento particular. A clínica emite recibo (o paciente pode pedir reembolso ao plano dele) e nota fiscal.

ESTRUTURA: estacionamento próprio e gratuito. A clínica é acessível para cadeirante e para quem tem dificuldade de andar.

O QUE LEVAR: exames de imagem (ressonância ou tomografia) com até 5 anos, se tiver, e roupa confortável.

CONTATOS: WhatsApp oficial (84) 99107-4334.`;

const DEMOGRAFIA =
  'PERFIL DA CIDADE — MOSSORÓ/RN\n' +
  '• Segunda maior cidade do Rio Grande do Norte, polo regional do oeste potiguar.\n' +
  '• A clínica fica no Nova Betânia, bairro central de comércio e serviços, no mesmo\n' +
  '  alinhamento da Polícia Federal e perto do hospital da Hapvida.';

async function main() {
  const token = process.env.MOSSORO_KOMMO_TOKEN;
  const spineToken = process.env.MOSSORO_SPINE_TOKEN;
  const anthropicKey = process.env.MOSSORO_ANTHROPIC_KEY;
  if (!token) throw new Error('Faltou MOSSORO_KOMMO_TOKEN no ambiente.');
  if (!spineToken) throw new Error('Faltou MOSSORO_SPINE_TOKEN no ambiente.');

  console.log('→ lendo a conta de destino para resolver os ids pelo nome:');
  const { ids, pipelineId, etapaPorNome } = await lerContaDeDestino(token);

  const src = await prisma.unit.findUnique({ where: { slug: SRC_SLUG }, include: { actions: true } });
  if (!src) throw new Error(`Unidade fonte "${SRC_SLUG}" não encontrada.`);
  console.log(`→ fonte: ${src.slug} (${src.actions.length} ações)`);

  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (NAO_COPIAR.has(k) || k === 'actions') continue;
    clone[k] = v;
  }
  for (const campo of ['systemPrompt', 'sourcePapel', 'sourceProdutos', 'sourceNegocio', 'personaGreeting', 'personaCompanyName']) {
    if (typeof clone[campo] === 'string') clone[campo] = adaptarTexto(clone[campo] as string);
  }
  clone.sourceDemografia = DEMOGRAFIA;
  // realidade operacional NUNCA é herdada — ver comentário de NEGOCIO
  clone.sourceNegocio = NEGOCIO;

  Object.assign(clone, {
    slug: DST_SLUG,
    name: DST_NAME,
    kommoSubdomain: KOMMO_SUBDOMAIN,
    kommoAccessToken: token,
    llmProvider: 'anthropic',
    anthropicApiKey: anthropicKey || null,
    anthropicModel: process.env.MOSSORO_CLAUDE_MODEL || 'claude-sonnet-5',
    ...ids,
    kommoWonStatusIds: [142],
    kommoAllowedStatusIds: Array.from(etapaPorNome.values()).filter((id) =>
      ETAPAS_PERMITIDAS.some((n) => etapaPorNome.get(chave(n)) === id),
    ),
    // Ficha da clínica — dado real, nunca herdado
    clinicAddress: FICHA.endereco,
    clinicMapUrl: FICHA.maps,
    pixKey: FICHA.pixKey,
    pixHolder: FICHA.pixHolder,
    // Agenda da franquia
    spineEnabled: true,
    spineBaseUrl: 'https://app-api-prod.doutorhernia.com.br',
    spineToken,
    spineAgendaStart: FICHA.agendaInicio,
    spineAgendaEnd: FICHA.agendaFim,
    spineAgendaDays: FICHA.diasDaSemana,
    spineDayHours: FICHA.horarioPorDia,
    spineSlotMinutes: FICHA.slotMinutos,
    spineLunchStart: null,
    spineLunchEnd: null,
    spineBookingRequiresPayment: false, // a clínica segura o horário e ele paga depois
    // ENTREGA DESLIGADA até o teste passar no número do João
    kommoSalesbotId: null,
    voiceReplyEnabled: false,
  });

  const existente = await prisma.unit.findUnique({ where: { slug: DST_SLUG }, include: { actions: true } });
  if (existente && existente.actions.length > 0) {
    console.log(`⛔ ${DST_SLUG} já existe com ${existente.actions.length} ações. Abortando pra não duplicar.`);
    return;
  }

  let totalTrocados = 0;
  const semMapaGeral = new Set<string>();
  const acoesPreparadas = src.actions.map((a) => {
    const { passos, trocados, semMapa } = remapear((a.actions ?? []) as Passo[], pipelineId, etapaPorNome);
    totalTrocados += trocados;
    for (const s of semMapa) semMapaGeral.add(s);
    return { origem: a, passos };
  });

  if (SECO) {
    console.log('\n=== MODO SECO — nada foi gravado ===');
    console.log(`unidade: ${DST_SLUG} | funil ${pipelineId} | campos ${JSON.stringify(ids)}`);
    console.log(`etapas permitidas: ${(clone.kommoAllowedStatusIds as number[]).join(', ')}`);
    console.log(`ações: ${acoesPreparadas.length} | move_stage reapontados: ${totalTrocados}`);
    console.log(`Pix: ${FICHA.pixKey} (${FICHA.pixHolder})`);
    console.log(`valores: R$ ${FICHA.precoAntecipado} antecipado / R$ ${FICHA.precoNoDia} no dia`);
    console.log(`agenda: ${FICHA.agendaInicio}-${FICHA.agendaFim}, sexta até 17:00, slot ${FICHA.slotMinutos}min, sem sábado`);
    if (semMapaGeral.size > 0) console.log(`⚠️ move_stage sem mapa: ${[...semMapaGeral].join(' | ')}`);
    const amostra = adaptarTexto(String(src.sourceProdutos ?? '')).slice(0, 300);
    console.log(`\namostra de <produtos> adaptado:\n${amostra}`);
    return;
  }

  const unidade = existente
    ? await prisma.unit.update({ where: { slug: DST_SLUG }, data: clone })
    : await prisma.unit.create({ data: clone as never });
  console.log(`✅ Unidade ${existente ? 'atualizada' : 'criada'}: ${unidade.id} (${unidade.slug})`);

  if (acoesPreparadas.length > 0) {
    await prisma.unitAction.createMany({
      data: acoesPreparadas.map(({ origem, passos }) => ({
        unitId: unidade.id,
        conditionDescription: origem.conditionDescription,
        actions: passos as never,
        actionKind: origem.actionKind,
        actionParams: origem.actionParams as never,
        notes: origem.notes,
        enabled: origem.enabled,
      })),
    });
  }
  console.log(`✅ ${acoesPreparadas.length} ações replicadas — ${totalTrocados} move_stage reapontados para o funil ${pipelineId}.`);
  if (semMapaGeral.size > 0) console.log(`⚠️ move_stage sem mapa: ${[...semMapaGeral].join(' | ')}`);

  console.log('\n⚠️  Falta, fora do banco:');
  console.log('   - Entrega DESLIGADA de propósito (kommoSalesbotId=null). Ligar só depois do teste.');
  console.log('   - Foto da fachada e números individuais da recepção não vieram na ficha.');
  console.log(`   - Webhook: https://agente-vps.doutordigitalconsultoria.com/api/webhooks/${DST_SLUG}/kommo`);
  console.log('   - Rotacionar os dois tokens: passaram pelo chat em 17/09/2026.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('❌ replicate-mossoro falhou:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
