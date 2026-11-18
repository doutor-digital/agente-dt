/**
 * ⚑ Origem pelo TEXTO PRONTO da primeira mensagem (18/11/2026, Petrópolis e Caxias).
 *
 * Por que existe: as duas unidades estão no WhatsApp Lite (QR). Pelo Lite o Kommo NÃO recebe o `referral` do anúncio (CTWA), então o
 * rastreio nunca grava ⚑ Origem: dos cartões criados de 16 a 18/11, 56 de 58 (Petrópolis) e 49 de 49 (Caxias) ficaram sem origem, e a equipe
 * reclamou. Mas a 1ª mensagem do lead quase sempre é um TEXTO PRONTO que o anúncio ou o site coloca na caixa de mensagem
 * («Olá estava navegando e gostaria de mais informações sobre tratamento.», «Tenho interesse. Por favor, você poderia me passar mais
 * informações?»). Quem manda essa frase veio do anúncio/site; isto aqui lê a frase e preenche a ⚑ Origem que o rastreio não preencheu.
 *
 * A LISTA É DADO, não código: `units.pipeline_intents.origem_por_texto` = `[{ "texto": "<frase>", "origem": "<nome exato da opção do ⚑ Origem>",
 * "anuncio": true|false, "contem": true|false }]`. Sem a chave = a unidade não usa. A opção do campo é resolvida pelo NOME na conta (nunca por id fixo).
 * `contem: true` = a frase pode estar no MEIO da fala (palavras inteiras), não só no começo. É o caso do formulário da GAC (18/11/2026,
 * Taubaté, Olímpia, Capivari, Boituva e Caxias): «Olá! Meu nome é X, moro em Y e estou com Z. Vim pelo formulário e quero saber mais…» —
 * o começo muda a cada lead, o que identifica é «vim pelo formulario».
 *
 * O que ela NUNCA faz: sobrescrever ⚑ Origem que já tem valor (do rastreio, da SDR ou da Sofia — lê o cartão imediatamente antes de gravar),
 * mexer em etapa, mandar mensagem. Só olha as primeiras falas do paciente (`MAX_FALAS_OLHADAS`): "Bom dia" no meio da conversa não conta.
 * Dois escritores do mesmo campo é regravação eterna: aqui só se escreve em campo VAZIO e uma vez por cartão (memória do processo); se o
 * rastreio chegar depois com o referral de verdade, ele sobrescreve e este não volta a mexer (o campo já não está vazio).
 *
 * ESTADOS (chave `ORIGEM_TEXTO_PRONTO_SLUGS`, tela de Automações):
 *  - desligado (padrão): nada roda, nenhuma consulta ao banco nem ao Kommo.
 *  - seco: lê a conversa e o cartão e só REGISTRA «gravaria ⚑ Origem = X» na tela «Só no papel». Não escreve nada no Kommo.
 *  - ligado: grava o campo e deixa uma nota no cartão. `cadastro-todo-lead` passa a tratar a frase de `anuncio: true` como lead de anúncio.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { grupoDaUnidade, pularCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { vazioNoCartao } from './ponte-guia.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';

export const ID_ORIGEM_TEXTO_PRONTO = 'origem-texto-pronto';
/** A chave dentro de `units.pipeline_intents` onde mora a lista. */
export const CHAVE_DA_LISTA = 'origem_por_texto';
/** O nome do campo no Kommo (id é por conta: sempre pelo nome). */
export const NOME_DO_CAMPO_ORIGEM = '⚑ Origem';
/** Quantas das primeiras falas do paciente a frase pode estar. */
export const MAX_FALAS_OLHADAS = 3;
/** Frase normalizada menor que isto é ignorada: como a comparação é «começa com», uma frase curta («oi») casaria com meio mundo. */
export const MIN_CARACTERES_DA_FRASE = 15;
const MAX_ENTRADAS = 50;

export const estadoDaOrigemPorTexto = (slug: string, raw: string | undefined = process.env.ORIGEM_TEXTO_PRONTO_SLUGS): Estado => estadoDaAutomacao(slug, ID_ORIGEM_TEXTO_PRONTO, raw);

// ── a lista e a comparação (puro) ─────────────────────────────────────────────────────────────────

/** minúsculas, sem acento, sem pontuação nem emoji, espaços colapsados. */
export function normalizarFrase(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface EntradaDaLista {
  /** A frase como está no cadastro (para log e nota). */
  texto: string;
  /** O nome da opção do ⚑ Origem. */
  origem: string;
  /** A frase é de anúncio PAGO (o `cadastro-todo-lead` trata como lead de anúncio). */
  anuncio: boolean;
  /** A frase pode estar no meio da fala (palavras inteiras); sem isto, só vale no começo. */
  contem: boolean;
  /** A frase normalizada: contra isto se compara. */
  chave: string;
}

/**
 * Lê `origem_por_texto` do JSON da unidade. Tolerante: item malformado é descartado (e dito no log), nunca derruba nada. A mais LONGA vem
 * primeiro, para uma frase específica ganhar de outra que seja o começo dela.
 */
export function lerListaDeTextos(pipelineIntents: unknown, aviso: (motivo: string) => void = () => undefined): EntradaDaLista[] {
  if (!pipelineIntents || typeof pipelineIntents !== 'object' || Array.isArray(pipelineIntents)) return [];
  const bruta = (pipelineIntents as Record<string, unknown>)[CHAVE_DA_LISTA];
  if (bruta === undefined || bruta === null) return [];
  if (!Array.isArray(bruta)) {
    aviso(`${CHAVE_DA_LISTA} não é uma lista`);
    return [];
  }
  const out: EntradaDaLista[] = [];
  for (const item of bruta.slice(0, MAX_ENTRADAS)) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const texto = typeof o.texto === 'string' ? o.texto.trim() : '';
    const origem = typeof o.origem === 'string' ? o.origem.trim() : '';
    const chave = normalizarFrase(texto);
    if (!origem || chave.length < MIN_CARACTERES_DA_FRASE) {
      aviso(`item ignorado (sem origem ou frase com menos de ${MIN_CARACTERES_DA_FRASE} letras): ${JSON.stringify(item).slice(0, 120)}`);
      continue;
    }
    out.push({ texto, origem, anuncio: o.anuncio === true, contem: o.contem === true, chave });
  }
  return out.sort((a, b) => b.chave.length - a.chave.length);
}

/**
 * A fala COMEÇA com a frase (o lead às vezes acrescenta algo depois) — e termina numa fronteira de palavra. Com `contem`, a frase pode estar
 * em qualquer ponto da fala, sempre em palavras inteiras («vim pelo formulario» não casa com «revim pelo formularios»).
 */
export function casarFala(fala: unknown, lista: readonly EntradaDaLista[]): EntradaDaLista | null {
  const n = normalizarFrase(fala);
  if (!n) return null;
  return lista.find((e) => n === e.chave || n.startsWith(`${e.chave} `) || (e.contem && ` ${n} `.includes(` ${e.chave} `))) ?? null;
}

/** A primeira fala (entre as `max` primeiras) que casa com a lista. */
export function casarPrimeirasFalas(falas: readonly string[], lista: readonly EntradaDaLista[], max = MAX_FALAS_OLHADAS): { entrada: EntradaDaLista; fala: string } | null {
  for (const fala of falas.slice(0, max)) {
    const entrada = casarFala(fala, lista);
    if (entrada) return { entrada, fala };
  }
  return null;
}

type OpcaoDoCampo = { id: number; value: string };
export type CampoResolvido = { def: DefinicaoDeCampo; opcao: OpcaoDoCampo };

/**
 * O campo ⚑ Origem da conta e a opção de nome `origem`. Pelo NOME, nunca por id: exato primeiro, depois sem acento/caixa — só se for única.
 * `motivo` diz por que não deu (campo ausente, ambíguo, não é lista, opção inexistente).
 */
export function resolverOpcao(defs: readonly DefinicaoDeCampo[], origem: string): CampoResolvido | { motivo: string } {
  const campos = defs.filter((d) => String(d.name ?? '').trim() === NOME_DO_CAMPO_ORIGEM);
  if (campos.length === 0) return { motivo: `a conta não tem o campo «${NOME_DO_CAMPO_ORIGEM}»` };
  if (campos.length > 1) return { motivo: `a conta tem ${campos.length} campos «${NOME_DO_CAMPO_ORIGEM}» — ambíguo` };
  const def = campos[0];
  if (def.type !== 'select' && def.type !== 'radiobutton') return { motivo: `«${NOME_DO_CAMPO_ORIGEM}» é do tipo ${def.type}, não lista` };
  const enums = (def.enums ?? []).filter((e) => typeof e.value === 'string');
  const exatas = enums.filter((e) => e.value.trim() === origem.trim());
  if (exatas.length === 1) return { def, opcao: exatas[0] };
  if (exatas.length > 1) return { motivo: `a opção «${origem}» aparece ${exatas.length} vezes — ambíguo` };
  const parecidas = enums.filter((e) => normalizarFrase(e.value) === normalizarFrase(origem));
  if (parecidas.length === 1) return { def, opcao: parecidas[0] };
  return { motivo: `a opção «${origem}» não existe em «${NOME_DO_CAMPO_ORIGEM}» nesta conta` };
}

export type PlanoDaOrigem = { tipo: 'gravar'; campo: CampoResolvido } | { tipo: 'pular'; motivo: string; aviso?: boolean };

/** Com o cartão na mão: grava ou pula? Puro. Cartão com ⚑ Origem preenchida NUNCA é tocado. */
export function planejarOrigem(lead: Pick<KommoLead, 'id' | 'status_id' | 'pipeline_id' | 'custom_fields_values'>, defs: readonly DefinicaoDeCampo[], entrada: Pick<EntradaDaLista, 'origem'>): PlanoDaOrigem {
  const r = resolverOpcao(defs, entrada.origem);
  if ('motivo' in r) return { tipo: 'pular', motivo: r.motivo, aviso: true };
  if (!vazioNoCartao(lead, r.def.id)) return { tipo: 'pular', motivo: `«${NOME_DO_CAMPO_ORIGEM}» já tem valor — não sobrescrevo` };
  return { tipo: 'gravar', campo: r };
}

export function textoDaNota(entrada: Pick<EntradaDaLista, 'texto' | 'origem'>): string {
  return `${NOME_DO_CAMPO_ORIGEM} preenchida pelo texto pronto da primeira mensagem («${entrada.texto.slice(0, 120)}») = ${entrada.origem}. O WhatsApp Lite não traz o anúncio, então esta origem é um palpite pela frase; se estiver errada, troque.`;
}

// ── o que toca o banco e o Kommo (injetável para teste) ───────────────────────────────────────────

export type KommoDaOrigem = Pick<KommoClient, 'getLead' | 'listarCamposDoCartao' | 'gravarCamposDoLead' | 'addLeadNote'>;
export type UnidadeDaOrigem = Pick<Unit, 'id' | 'slug' | 'pipelineIntents'>;

export interface DepsDaOrigem {
  estado(slug: string): Estado;
  /** As primeiras `n` falas do PACIENTE (nunca as da IA nem da equipe), da mais antiga para a mais nova. Lança se o banco falhar. */
  primeirasFalas(unitId: string, leadId: number, n: number): Promise<string[]>;
  kommo(unit: UnidadeDaOrigem): KommoDaOrigem;
  campos(unit: UnidadeDaOrigem, kommo: KommoDaOrigem): Promise<DefinicaoDeCampo[]>;
  grupo(unitId: string): Promise<GrupoDoCrm | null>;
  simular: typeof registrarSimulacao;
}

const CACHE_DOS_CAMPOS_MS = 10 * 60_000;
const cacheCampos = new Map<string, { em: number; defs: DefinicaoDeCampo[] }>();

export const depsReais: DepsDaOrigem = {
  estado: (slug) => estadoDaOrigemPorTexto(slug),
  async primeirasFalas(unitId, leadId, n) {
    const linhas = await prisma.message.findMany({
      where: { role: 'user', conversation: { unitId, leadId: String(leadId) } },
      orderBy: { createdAt: 'asc' },
      take: n,
      select: { content: true },
    });
    return linhas.map((l) => l.content);
  },
  kommo: (unit) => createKommoClient(unit as Unit),
  async campos(unit, kommo) {
    const hit = cacheCampos.get(unit.id);
    if (hit && Date.now() - hit.em < CACHE_DOS_CAMPOS_MS) return hit.defs;
    const defs = (await kommo.listarCamposDoCartao()) as DefinicaoDeCampo[];
    if (cacheCampos.size > 200) cacheCampos.clear();
    cacheCampos.set(unit.id, { em: Date.now(), defs });
    return defs;
  },
  grupo: (unitId) => grupoDaUnidade(unitId),
  simular: registrarSimulacao,
};

/** A lista da unidade; sem `pipelineIntents` no objeto (quem chamou passou só id/slug) vai buscar no banco. */
async function listaDaUnidade(unit: { id: string; slug: string; pipelineIntents?: unknown }): Promise<EntradaDaLista[]> {
  let intents: unknown = unit.pipelineIntents;
  if (!('pipelineIntents' in unit)) {
    intents = (await prisma.unit.findUnique({ where: { id: unit.id }, select: { pipelineIntents: true } }))?.pipelineIntents;
  }
  return lerListaDeTextos(intents, (motivo) => logger.warn({ unit: unit.slug }, `${ID_ORIGEM_TEXTO_PRONTO}: ${motivo}`));
}

/**
 * A frase da lista que abre a conversa deste lead, ou `null`. Lê só as primeiras falas do paciente no banco — não depende de o
 * Kommo ter qualquer campo gravado. Nunca lança.
 */
export async function frasePronta(unit: { id: string; slug: string; pipelineIntents?: unknown }, leadId: number, deps: Pick<DepsDaOrigem, 'primeirasFalas'> = depsReais): Promise<{ entrada: EntradaDaLista; fala: string } | null> {
  try {
    const lista = await listaDaUnidade(unit);
    if (lista.length === 0) return null;
    const falas = await deps.primeirasFalas(unit.id, leadId, MAX_FALAS_OLHADAS);
    return casarPrimeirasFalas(falas, lista);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_ORIGEM_TEXTO_PRONTO}: não consegui ler as primeiras falas`);
    return null;
  }
}

/**
 * Para o `cadastro-todo-lead`: a conversa abre com uma frase de ANÚNCIO da lista? SÓ com a automação LIGADA (em seco o cadastro segue como
 * hoje). Não olha o cartão: o Lite nunca grava o rastreio. Nunca lança.
 */
export async function anuncioPelaFrase(unit: { id: string; slug: string; pipelineIntents?: unknown }, leadId: number, deps: Pick<DepsDaOrigem, 'estado' | 'primeirasFalas'> = depsReais): Promise<EntradaDaLista | null> {
  if (deps.estado(unit.slug) !== 'ligado') return null;
  const r = await frasePronta(unit, leadId, deps);
  return r?.entrada.anuncio ? r.entrada : null;
}

// ── a automação ───────────────────────────────────────────────────────────────────────────────────

export type ResultadoDaOrigem =
  | { tipo: 'desligada' | 'ignorada' | 'sem-lista' | 'sem-casamento' | 'ja-feito' | 'em-curso' }
  | { tipo: 'pulou'; motivo: string }
  | { tipo: 'seco'; origem: string }
  | { tipo: 'gravou'; origem: string; campo: string };

const UM_DIA_MS = 24 * 3600_000;
/** `estado|unidade|lead` → até quando não olhar de novo. Só desfechos que não mudam sozinhos; falha de Kommo/banco NÃO entra (a próxima fala tenta). */
const feitos = new Map<string, number>();
/** `unidade|lead` → a tarefa de origem em andamento. O cadastro na franquia espera por ela (`esperarOrigem`): o espelho de leads lê o ⚑ Origem do cartão ao criar o lead lá. */
const emCurso = new Map<string, Promise<unknown>>();
/** Quanto o cadastro espera, no máximo, a origem terminar (um `getLead` + um PATCH + uma nota; o Kommo pendurado não prende o cadastro). */
export const ESPERA_MAXIMA_DA_ORIGEM_MS = 8_000;

/**
 * O cadastro na franquia chama isto antes de criar o lead: se a origem deste lead está sendo gravada AGORA, espera ela terminar (no máximo
 * `ESPERA_MAXIMA_DA_ORIGEM_MS`). Sem tarefa em andamento (chave desligada, fala que não casa, já feito) devolve na hora. Nunca lança.
 */
export async function esperarOrigem(unitId: string, leadId: number, ateMs = ESPERA_MAXIMA_DA_ORIGEM_MS): Promise<void> {
  const p = emCurso.get(`${unitId}|${leadId}`);
  if (!p) return;
  let t: NodeJS.Timeout | undefined;
  const prazo = new Promise<void>((resolve) => {
    t = setTimeout(resolve, ateMs);
    t.unref?.();
  });
  await Promise.race([p.then(() => undefined, () => undefined), prazo]).finally(() => clearTimeout(t));
}

const lembrar = (chave: string, ms: number) => {
  if (feitos.size > 20_000) feitos.clear();
  feitos.set(chave, Date.now() + ms);
};

/** Só para teste. */
export function _limparOrigemParaTeste(): void {
  feitos.clear();
  emCurso.clear();
  cacheCampos.clear();
}

/**
 * Chamada no fim de TODO turno de chat (a Sofia falou ou a IA foi pulada). Nunca lança e não espera ninguém: quem chama a solta.
 * Desligada: devolve antes de qualquer consulta.
 */
export async function aplicarOrigemPorTexto(
  args: { unit: UnidadeDaOrigem; leadId: number; isChatMessage: boolean },
  deps: DepsDaOrigem = depsReais,
): Promise<ResultadoDaOrigem> {
  const { unit, leadId } = args;
  try {
    const estado = deps.estado(unit.slug);
    if (estado === 'desligado') return { tipo: 'desligada' };
    // só mensagem de chat de verdade: webhook de campo/etapa traz texto sintético
    if (!args.isChatMessage || !Number.isFinite(leadId) || leadId <= 0) return { tipo: 'ignorada' };
    const chave = `${estado}|${unit.id}|${leadId}`;
    if ((feitos.get(chave) ?? 0) > Date.now()) return { tipo: 'ja-feito' };
    const dono = `${unit.id}|${leadId}`;
    if (emCurso.has(dono)) return { tipo: 'em-curso' };
    // registrado de forma SÍNCRONA (antes de qualquer await): quem chama em seguida já enxerga a tarefa em `esperarOrigem`
    const p = processar(estado, chave, unit, leadId, deps);
    emCurso.set(dono, p);
    try {
      return await p;
    } finally {
      emCurso.delete(dono);
    }
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_ORIGEM_TEXTO_PRONTO}: erro — pulei (a próxima fala tenta de novo)`);
    return { tipo: 'pulou', motivo: 'erro inesperado' };
  }
}

async function processar(estado: Estado, chave: string, unit: UnidadeDaOrigem, leadId: number, deps: DepsDaOrigem): Promise<ResultadoDaOrigem> {
  const lista = lerListaDeTextos(unit.pipelineIntents, (motivo) => logger.warn({ unit: unit.slug }, `${ID_ORIGEM_TEXTO_PRONTO}: ${motivo}`));
  if (lista.length === 0) return { tipo: 'sem-lista' };

  const falas = await deps.primeirasFalas(unit.id, leadId, MAX_FALAS_OLHADAS);
  const achou = casarPrimeirasFalas(falas, lista);
  if (!achou) {
    // as 3 primeiras falas já existem e não casam: nada muda nas próximas mensagens
    if (falas.length >= MAX_FALAS_OLHADAS) lembrar(chave, UM_DIA_MS);
    return { tipo: 'sem-casamento' };
  }
  const { entrada, fala } = achou;

  const kommo = deps.kommo(unit);
  // a lista de campos (cache) e o grupo ANTES de ler o cartão: o cartão é lido imediatamente antes de gravar, para a janela de corrida ser a menor possível
  const defs = await deps.campos(unit, kommo);
  const grupo = await deps.grupo(unit.id);
  const lead = await kommo.getLead(leadId);
  // Kommo dividido: o cartão de outra unidade (ou sem unidade) não é meu
  if (pularCartao(grupo, unit.id, lead, {})) {
    lembrar(chave, 2 * 60_000); // cartão novo ainda sem unidade: o robô de unidade pode marcá-lo logo, tenta de novo em 2 min
    return { tipo: 'pulou', motivo: 'Kommo dividido: o cartão é de outra unidade (ou ainda não tem unidade)' };
  }
  const plano = planejarOrigem(lead, defs, entrada);
  if (plano.tipo === 'pular') {
    (plano.aviso ? logger.warn : logger.info).call(logger, { unit: unit.slug, leadId, origem: entrada.origem }, `${ID_ORIGEM_TEXTO_PRONTO}: ${plano.motivo}`);
    lembrar(chave, plano.aviso ? 10 * 60_000 : UM_DIA_MS);
    return { tipo: 'pulou', motivo: plano.motivo };
  }

  const motivo = `1ª fala do paciente «${fala.replace(/\s+/g, ' ').trim().slice(0, 100)}» ${entrada.contem ? 'contém' : 'começa com'} a frase pronta «${entrada.texto.slice(0, 100)}»${entrada.anuncio ? ' (anúncio)' : ''}`;
  if (estado === 'seco') {
    deps.simular(unit, ID_ORIGEM_TEXTO_PRONTO, { leadId, acao: 'gravaria', alvo: NOME_DO_CAMPO_ORIGEM, valor: entrada.origem, noCartao: null, motivo });
    logger.info({ unit: unit.slug, leadId, origem: entrada.origem, anuncio: entrada.anuncio }, `${ID_ORIGEM_TEXTO_PRONTO} [seco]: gravaria ${NOME_DO_CAMPO_ORIGEM} = ${entrada.origem}`);
    lembrar(chave, UM_DIA_MS);
    return { tipo: 'seco', origem: entrada.origem };
  }

  // ligado: a chave pode ter sido desligada enquanto o Kommo respondia
  if (deps.estado(unit.slug) !== 'ligado') return { tipo: 'pulou', motivo: 'a chave foi desligada enquanto eu lia o cartão' };
  await kommo.gravarCamposDoLead(leadId, [{ field_id: plano.campo.def.id, values: [{ enum_id: plano.campo.opcao.id }] }]);
  lembrar(chave, UM_DIA_MS);
  logger.info({ unit: unit.slug, leadId, origem: entrada.origem, anuncio: entrada.anuncio }, `${ID_ORIGEM_TEXTO_PRONTO}: campo gravado`);
  await kommo.addLeadNote(leadId, textoDaNota(entrada)).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_ORIGEM_TEXTO_PRONTO}: a nota não entrou (o campo gravou)`));
  return { tipo: 'gravou', origem: entrada.origem, campo: NOME_DO_CAMPO_ORIGEM };
}
