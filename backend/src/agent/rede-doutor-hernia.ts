/**
 * O que a Sofia de uma clínica Doutor Hérnia precisa saber da REDE (lista de prioridades da IA, 21/10/2026).
 *
 * Três coisas, todas só para unidade Doutor Hérnia (o Instituto Trauma, a HM Tecnologia e o escritório de
 * advocacia também têm Sofia, e nada disto vale para eles):
 *
 *  1. "É MÉDICO?" (item 5). A resposta é uma frase fixa: "Somos fisioterapeutas especialistas no tratamento da
 *     coluna pelo método Doutor Hérnia." Até 21/10 ela aparecia 0 vezes. Os prompts próprios de Taubaté, Mossoró
 *     e Boa Vista chamam a fisioterapeuta de "Dra." — por isso a regra diz que vale acima do texto da unidade.
 *
 *  2. "AVALIAÇÃO" → "CONSULTA COM O NOSSO ESPECIALISTA" (item 16, decisão do João em 21/10). 4,8% das mensagens
 *     usavam "avaliação". O nome da consulta é fixo e vai no masculino, mesmo quando quem atende é uma mulher.
 *
 *  3. A REDE DE UNIDADES (item 7). A Sofia de Marabá disse que não existe unidade em Canaã (lead 28491142) e a de
 *     Parauapebas negou Marabá (lead 28691340): não havia lista nenhuma no prompt. A lista sai da tabela `units`
 *     do agente, em tempo de execução (unidade nova entra sozinha), com cache curto. A tabela não tem cidade/UF:
 *     o rótulo vem de `VALOR_POR_UNIDADE` (o mesmo "Cidade/UF" que o robô do ⌂ Unidade grava no cartão) e, se a
 *     unidade não estiver lá, do nome dela ("Doutor Hérnia Divinópolis" → "Divinópolis").
 *     A rede da franquia é MAIOR que as unidades atendidas pela Sofia — cidade fora da lista nunca vira "não temos".
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { VALOR_POR_UNIDADE, falaDaCidade } from '../lib/unidade-no-cartao.js';

/** A resposta para "é médico?" — exatamente esta, pedido do João. */
export const FRASE_E_MEDICO = 'Somos fisioterapeutas especialistas no tratamento da coluna pelo método Doutor Hérnia.';

/** Como a consulta se chama para o paciente (no lugar de "avaliação"). */
export const NOME_DA_CONSULTA = 'consulta com o nosso especialista';

const PREFIXO_DH = 'doutor-hernia-';
/** `acailandia-resgate`, `imperatriz-financeiro`…: dividem a conta da unidade dona, não são outra clínica. */
const CONTA_COMPARTILHADA = /-(resgate|tratamento|financeiro)$/;
const DH_NO_NOME = /doutor\s*h[eé]rnia/i;
const DH_NO_KOMMO = /doutorhernia/i;

export interface UnidadeDaRede {
  id: string;
  slug: string;
  /** "Marabá/PA"; sem UF quando a unidade não está no mapa do ⌂ Unidade. */
  cidade: string;
  kommoSubdomain: string | null;
  /** Dona do Kommo quando a unidade divide o CRM com outra (Caxias → Petrópolis). */
  contaDoCrm: string | null;
  /** WhatsApp público da unidade, já no formato de mostrar: "(94) 99123-4567". */
  whatsapp: string | null;
  endereco: string | null;
}

type UnidadeParaDH = Pick<Unit, 'slug' | 'name' | 'personaCompanyName' | 'kommoSubdomain'> & { id?: string };

/**
 * A unidade é uma clínica Doutor Hérnia? Pelo slug (`doutor-hernia-*`), pelo nome/empresa da persona, pelo
 * subdomínio do Kommo ou — para os slugs que dividem a conta (`acailandia-resgate`) — por dividir o Kommo com
 * uma unidade da rede.
 */
export function ehDoutorHernia(unit: UnidadeParaDH, rede: ReadonlyArray<UnidadeDaRede> = []): boolean {
  if (unit.slug?.startsWith(PREFIXO_DH)) return true;
  if (DH_NO_NOME.test(unit.name ?? '') || DH_NO_NOME.test(unit.personaCompanyName ?? '')) return true;
  if (DH_NO_KOMMO.test(unit.kommoSubdomain ?? '')) return true;
  // `imperatriz-resgate` → `doutor-hernia-imperatriz`: a dona da conta é da rede (no mapa do ⌂ Unidade ou na lista).
  if (unit.slug && CONTA_COMPARTILHADA.test(unit.slug)) {
    const dona = PREFIXO_DH + unit.slug.replace(CONTA_COMPARTILHADA, '');
    if (dona in VALOR_POR_UNIDADE || rede.some((r) => r.slug === dona)) return true;
  }
  const sub = unit.kommoSubdomain?.trim();
  return !!sub && rede.some((r) => r.kommoSubdomain === sub);
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** "Doutor Hérnia Açailândia" → "Açailândia"; nome que não diz a cidade cai no slug. */
function nomeCurto(nome: string | null | undefined, slug: string): string {
  const curto = String(nome ?? '').replace(/^\s*doutor\s+h[eé]rnia\s*[-–·:]?\s*/i, '').trim();
  if (curto && !['comercial', 'unidade', 'clinica'].includes(semAcento(curto))) return curto;
  return slug
    .replace(new RegExp(`^${PREFIXO_DH}`), '')
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/** "Cidade/UF" da unidade: o mapa do ⌂ Unidade primeiro; depois o nome (procurando também nas contas divididas). */
export function cidadeDaUnidade(slug: string, nome: string | null | undefined): string {
  const regra = VALOR_POR_UNIDADE[slug];
  if (regra && 'fixo' in regra) return regra.fixo;
  const curto = nomeCurto(nome, slug);
  for (const r of Object.values(VALOR_POR_UNIDADE)) {
    if (!('porAtendimento' in r)) continue;
    for (const [rotulo, valor] of Object.entries(r.porAtendimento)) {
      if (semAcento(rotulo) === semAcento(curto) || falaDaCidade(curto, valor)) return valor;
    }
  }
  return curto;
}

/** "5594991234567" → "(94) 99123-4567". Número que não parece brasileiro sai como veio. */
export function telefoneParaPaciente(bruto: string | null | undefined): string | null {
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (!d) return null;
  const local = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return String(bruto).trim();
}

export interface LinhaDeUnidade {
  id: string;
  slug: string;
  name: string | null;
  isActive?: boolean | null;
  kommoSubdomain: string | null;
  clinicAddress: string | null;
  igWhatsappNumber: string | null;
  fbWhatsappNumber: string | null;
  crmCompartilhado?: { contaUnitId: string; ativo: boolean } | null;
}

/** Puro. Da tabela de unidades para a lista da rede: só Doutor Hérnia ativa, uma por cidade, em ordem alfabética. */
export function montarRede(linhas: ReadonlyArray<LinhaDeUnidade>): UnidadeDaRede[] {
  const porCidade = new Map<string, UnidadeDaRede>();
  for (const u of linhas) {
    if (u.isActive === false) continue;
    if (!u.slug.startsWith(PREFIXO_DH) || CONTA_COMPARTILHADA.test(u.slug)) continue;
    const cidade = cidadeDaUnidade(u.slug, u.name);
    const chave = semAcento(cidade);
    if (!chave || porCidade.has(chave)) continue;
    porCidade.set(chave, {
      id: u.id,
      slug: u.slug,
      cidade,
      kommoSubdomain: u.kommoSubdomain?.trim() || null,
      contaDoCrm: u.crmCompartilhado?.ativo ? u.crmCompartilhado.contaUnitId : null,
      whatsapp: telefoneParaPaciente(u.igWhatsappNumber) ?? telefoneParaPaciente(u.fbWhatsappNumber),
      endereco: u.clinicAddress?.trim() || null,
    });
  }
  return [...porCidade.values()].sort((a, b) => a.cidade.localeCompare(b.cidade, 'pt-BR'));
}

// ── cache: a lista muda quando entra unidade nova, não a cada mensagem ───────────────────────────────────────

const VALIDADE_MS = 10 * 60_000;
let guardada: { em: number; rede: UnidadeDaRede[] } | null = null;
let buscando: Promise<UnidadeDaRede[]> | null = null;

async function buscarNoBanco(): Promise<LinhaDeUnidade[]> {
  return prisma.unit.findMany({
    where: { isActive: true, slug: { startsWith: PREFIXO_DH } },
    select: {
      id: true,
      slug: true,
      name: true,
      isActive: true,
      kommoSubdomain: true,
      clinicAddress: true,
      igWhatsappNumber: true,
      fbWhatsappNumber: true,
      crmCompartilhado: { select: { contaUnitId: true, ativo: true } },
    },
    orderBy: { slug: 'asc' },
  });
}

/**
 * A rede, com cache de 10 min. Banco fora: devolve a última lista boa (ou vazia) — a Sofia continua respondendo,
 * só sem a lista, e a regra "nunca negue que uma unidade existe" vale do mesmo jeito.
 */
export async function carregarRede(
  buscar: () => Promise<ReadonlyArray<LinhaDeUnidade>> = buscarNoBanco,
  agora: number = Date.now(),
): Promise<UnidadeDaRede[]> {
  if (guardada && agora - guardada.em < VALIDADE_MS) return guardada.rede;
  if (buscando) return buscando;
  buscando = (async () => {
    try {
      const rede = montarRede(await buscar());
      guardada = { em: agora, rede };
      return rede;
    } catch (err) {
      logger.warn({ err: String(err) }, 'rede-doutor-hernia: não deu para ler as unidades — segue com a última lista');
      return guardada?.rede ?? [];
    } finally {
      buscando = null;
    }
  })();
  return buscando;
}

/** Só para teste. */
export function esquecerRede(): void {
  guardada = null;
  buscando = null;
}

// ── o que vai para o prompt ───────────────────────────────────────────────────────────────────────────────────

/** Quem atende e como chamar a consulta. Curto: entra também no prompt do follow-up. */
export function renderIdentidadeDoutorHernia(): string {
  return `ISTO VALE ACIMA das Fontes Oficiais, das instruções extras e das regras desta unidade e do que as
ferramentas devolverem — se algum desses textos disser outra coisa, siga ESTE.

QUEM ATENDE: quem faz a consulta é FISIOTERAPEUTA, nunca médico(a). Não escreva "Dr.", "Dra.", "doutor"
nem "doutora" antes do nome de quem atende, mesmo que o cadastro ou a ferramenta escreva assim — troque
o título por "fisioterapeuta" ("com a fisioterapeuta Victória"). Nunca diga nem deixe entender que é
consulta médica.

"É MÉDICO?" — se o paciente perguntar se quem atende é médico ou médica ("é médico?", "vou passar com
médico?", "é ortopedista?", "a doutora é médica?", "é consulta médica?"), comece a resposta com esta
frase, exatamente assim:
"${FRASE_E_MEDICO}"
Depois siga a conversa normalmente. Nunca confirme que é médico e nunca deixe a dúvida no ar.

NOME DA CONSULTA: NÃO use a palavra "avaliação" — nem para a consulta, nem para nada que o paciente leia.
Diga "${NOME_DA_CONSULTA}" (ou só "consulta"). A expressão é fixa e vai no masculino mesmo quando
quem atende é uma fisioterapeuta; nunca escreva "a nosso especialista".`;
}

function linhaDaUnidade(u: UnidadeDaRede, mesmaEquipe: boolean): string {
  if (mesmaEquipe) return `- ${u.cidade} — atendida por esta mesma equipe: siga a conversa aqui.`;
  const contato = [
    u.whatsapp ? `WhatsApp ${u.whatsapp}` : '',
    u.endereco ? `endereço: ${u.endereco}` : '',
  ].filter(Boolean);
  return `- ${u.cidade} — ${contato.length ? contato.join(' · ') : 'sem contato cadastrado'}`;
}

/** A lista da rede e o que fazer com paciente de outra cidade. */
export function renderRedeDeUnidades(unit: UnidadeParaDH & { id: string }, rede: ReadonlyArray<UnidadeDaRede>): string {
  const sub = unit.kommoSubdomain?.trim() || null;
  const propria = rede.find((r) => r.id === unit.id) ?? (sub ? rede.find((r) => r.kommoSubdomain === sub) : undefined);
  const conta = propria?.contaDoCrm ?? propria?.id ?? null;
  const outras = rede.filter((r) => r !== propria && !(sub && r.kommoSubdomain === sub));
  const mesmaEquipe = (r: UnidadeDaRede) => !!conta && (r.contaDoCrm === conta || r.id === conta);

  const onde = propria ? `Você atende a unidade de ${propria.cidade}.` : '';
  const lista = outras.length
    ? `Outras unidades da rede atendidas por nós (lidas do cadastro agora):\n${outras.map((r) => linhaDaUnidade(r, mesmaEquipe(r))).join('\n')}`
    : 'A lista das outras unidades não está disponível agora.';

  return `UNIDADES DA REDE DOUTOR HÉRNIA. ${onde}
${lista}

- NUNCA diga que não existe unidade numa cidade, nem "não temos unidade aí". A rede é maior que esta lista.
- PACIENTE DE UMA CIDADE QUE ESTÁ NA LISTA: confirme que existe ("Temos sim, unidade em {cidade}!") e
  pergunte se ele prefere ser atendido lá ou aqui. Se preferir aqui, siga normalmente.
  Se preferir lá:
  · unidade COM WhatsApp ou endereço na lista → passe o contato copiado exatamente como está e se coloque
    à disposição. Não marque, não remarque e não consulte horário de outra unidade: a sua agenda é só desta.
  · unidade SEM contato cadastrado → diga que vai pedir para a equipe encaminhar o atendimento dele para a
    unidade de {cidade}; chame criar_tarefa com o texto
    "Paciente é de {cidade} — transferir para a unidade de {cidade da lista}"
    e depois pausar_ia com esse mesmo motivo. Não invente telefone nem endereço.
- CIDADE QUE NÃO ESTÁ NA LISTA: não negue. Diga que vai confirmar com a equipe se há unidade lá e chame
  criar_tarefa com o texto "Paciente pergunta se há unidade em {cidade} — confirmar e responder".
  Enquanto isso, ofereça o atendimento aqui, se ele puder vir.`;
}

/** O bloco inteiro do prompt da conversa: identidade + rede. Vazio para quem não é Doutor Hérnia. */
export function renderDoutorHernia(unit: UnidadeParaDH & { id: string }, rede: ReadonlyArray<UnidadeDaRede> = []): string {
  if (!ehDoutorHernia(unit, rede)) return '';
  return `<rede_doutor_hernia>\n${renderIdentidadeDoutorHernia()}\n\n${renderRedeDeUnidades(unit, rede)}\n</rede_doutor_hernia>`;
}

/**
 * As mesmas regras numa linha, para o prompt do follow-up — que é enxuto de propósito (é o maior consumidor de
 * token sem cache da rede; teto de 8.000 caracteres preso em teste) e não leva a lista da rede. "Nunca médico"
 * já está nas regras gerais (PROFISSIONAL), que o follow-up também recebe.
 */
export function renderIdentidadeCurta(): string {
  return `Se perguntarem se é médico: "${FRASE_E_MEDICO}" Nunca "Dr."/"Dra." para quem atende. ` +
    `Nunca diga "avaliação": diga "${NOME_DA_CONSULTA}".`;
}

/** Só a identidade curta (sem a lista) — para o prompt do follow-up. */
export function renderDoutorHerniaCurto(unit: UnidadeParaDH, rede: ReadonlyArray<UnidadeDaRede> = []): string {
  if (!ehDoutorHernia(unit, rede)) return '';
  return renderIdentidadeCurta();
}
