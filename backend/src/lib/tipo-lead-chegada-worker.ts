/**
 * Preenche o ⬢ Tipo de lead quando o lead CHEGA. Regras e decisões do João em `tipo-lead-chegada.ts`.
 *
 * POR QUE UM WORKER E NÃO UM GANCHO DO TURNO DA IA (decisão de desenho, 06/11/2026):
 *  - o cartão nasce em qualquer unidade — com ou sem Sofia, com ou sem webhook de mensagem (Petrópolis/Caxias não mandam
 *    mensagem para o agente, e a Sofia só entra às 18h onde a SDR atende de dia). Um gancho no `processAgent` nunca
 *    acordaria aí; o `cadastro-todo-lead` só roda com a chave dele ligada e só se a unidade espelha lead na franquia;
 *  - a regra independe de agendar, e o sincronizador da franquia só visita cartão com consulta;
 *  - não pesa no turno da IA nem no 200 do webhook (o Kommo reenvia quem demora mais de 2 s).
 *  O custo é a espera: a cada 3 minutos olha os cartões abertos criados nas últimas 6 h com pelo menos 3 minutos de vida (dá tempo
 *  do contato ganhar telefone e nome). Mesmo molde do `renomear-lead-worker` e do `unidade-no-cartao-worker`.
 *
 * O que lê, por cartão, SÓ UMA VEZ (a decisão fica guardada neste processo): o contato (telefone e nome), os outros
 * cartões do contato (1º contato antigo) e — só se isso não bastou para Resgate — o ÍNDICE DE TELEFONES da franquia
 * (`franquia-indice-telefones.ts`, montado 1×/dia por unidade ativa; a franquia ignora filtro de telefone) mais uma busca
 * por nome de reforço.
 * Franquia ou Kommo com erro, sem telefone ou sem nome para buscar = NÃO grava e tenta de novo (10, 20, 30… até 60 min, enquanto
 * o cartão estiver na janela de 6 h); nunca vira "Cadastro" por erro.
 *
 * Chave `tipo-lead-chegada` na tela de Automações: desligado não faz nada (nem lê o Kommo); "só no papel" lê e decide mas só
 * registra "gravaria"; ligado grava SÓ em campo vazio, relendo o cartão antes (a SDR pode ter escolhido no meio).
 * Cartão com qualquer valor no campo (inclusive "Transferido de outra unidade") não é tocado. Só cartões novos: o estoque
 * antigo não é varrido por aqui.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDoKommo, grupoDaUnidade, unidadeDoCartao, type DonoDoCartao, type MembroDoCrm } from './crm-compartilhado.js';
import {
  CAMPO_PRIMEIRO_CONTATO,
  CAMPO_TIPO_LEAD,
  ID_AUTOMACAO as ID,
  acharCampo,
  decidirTipoDaChegada,
  franquiaConhece,
  opcaoDaConta,
  resgatePelaIdade,
  cartoesCriadosEmLote,
  type OutroCartao,
  type RespostaDaFranquia,
  type TipoDeLead,
} from './tipo-lead-chegada.js';
import { agendarIndice } from './franquia-indice-telefones.js';
import { algumaChaveAtiva, contatoPrincipal } from './renomear-lead-worker.js';
import { valorDoCampo } from './unidade-no-cartao-worker.js';
import { PREFIXO_PACIENTE_EXISTENTE } from '../services/paciente-existente.js';

const SWEEP_MS = 3 * 60_000;
const PRIMEIRA_VARREDURA_MS = 100_000;
/** Só cartões que nasceram nestas últimas horas: o estoque antigo não é deste robô. */
const JANELA_S = 6 * 3600;
/** Dá tempo do contato ganhar telefone e nome. */
const IDADE_MINIMA_S = 3 * 60;
const MAX_PAGINAS = 4;
/** Cartões que gastam leitura nova (outros cartões do contato + franquia) por rodada — importação em massa não vira rajada. */
const MAX_AVALIACOES_POR_RODADA = 25;
const MAX_GRAVACOES_POR_RODADA = 50;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
/** Espera entre tentativas de quem ficou sem decisão: 10, 20, 30… min, no máximo 60 — até a janela de 6 h acabar. */
const ESPERA_BASE_MS = 10 * 60_000;
const ESPERA_MAX_MS = 60 * 60_000;
/** Fechado no Kommo: ganho (142) ou perdido (143). */
const FECHADOS = new Set([142, 143]);

export interface Resumo {
  candidatos: number;
  gravados: number;
  simulados: number;
  desligados: number;
  jaPreenchidos: number;
  semUnidade: number;
  adiados: number;
  semOpcao: number;
  emLote: number;
  erros: number;
}

export type KommoDoTipo = Pick<
  KommoClient,
  'listLeadsNaJanela' | 'listLeadCustomFieldsTyped' | 'contatosBasicos' | 'contatoComCartoes' | 'listLeadsPorIds' | 'getLead' | 'setLeadCustomFieldValue'
>;

export interface DepsDoTipo {
  estadoDe(slug: string): Estado;
  donoDoCartao(contaUnit: Unit, lead: KommoLead): Promise<DonoDoCartao>;
  /**
   * O paciente deste cartão (ou a consulta) foi criado por NÓS — a Sofia ao agendar, o widget "só cadastrar": a busca na
   * franquia o acharia e isso não é "já existia". Daí em diante quem decide é o `campos-sdr`. Lança se o banco falhar.
   */
  pacienteCriadoPorNos(unitId: string, leadId: number): Promise<boolean>;
  franquiaConhece(unit: Unit, e: { titulo: string; nomeDoContato: string | null; telefone: string | null; chegadaEpoch: number | null }): Promise<RespostaDaFranquia>;
  /** Pede a carga (em segundo plano) do índice de telefones desta unidade, se for hora. Só para unidade ativa. */
  garantirIndice(unit: Unit): void;
  registrar: typeof registrarSimulacao;
}

export interface ContextoDaConta {
  unit: Unit;
  membros: ReadonlyArray<MembroDoCrm> | null;
  kommo: KommoDoTipo;
  deps: DepsDoTipo;
  /** epoch em segundos */
  agora: number;
  /** As unidades da conta (Petrópolis × Caxias: as duas). Sem isto, só `unit`. */
  unidadesDaConta?: ReadonlyArray<Unit>;
  /** pausa entre escritas (o teste zera) */
  pausaMs?: number;
}

interface Decidido {
  tipo: TipoDeLead;
  motivo: string;
  /** a prova foi a franquia (índice ou busca por nome), não a idade: reconferir o vínculo antes de gravar */
  viaFranquia: boolean;
}

// ── memória do processo: reiniciar só custa uma leitura a mais por cartão ──────────────────────────────────
const decididos = new Map<string, Decidido>();
const tentativas = new Map<string, { n: number; proxima: number }>();
const anunciados = new Set<string>();
const avisados = new Set<string>();

/** Só para teste. */
export function _limparParaTeste(): void {
  decididos.clear();
  tentativas.clear();
  anunciados.clear();
  avisados.clear();
}

function aparar(m: { size: number; clear(): void }): void {
  if (m.size > 20_000) m.clear();
}

function avisarUmaVez(slug: string, msg: string): void {
  if (avisados.has(`${slug}:${msg}`)) return;
  avisados.add(`${slug}:${msg}`);
  logger.warn({ unit: slug }, `${ID}: ${msg}`);
}

const dataDoCampo = (v: string | null): number | null => {
  const n = Number(v);
  return v !== null && Number.isFinite(n) && n > 0 ? n : null;
};

/** Os outros cartões do contato; `null` = não deu para ler (não é "nenhum"). */
async function outrosCartoesDoContato(kommo: KommoDoTipo, contatoId: number, leadId: number): Promise<OutroCartao[] | null> {
  const contato = await kommo.contatoComCartoes(contatoId);
  if (!contato) return null;
  const ids = contato.leadIds.filter((id) => id !== leadId);
  if (ids.length === 0) return [];
  try {
    const leads = await kommo.listLeadsPorIds(ids);
    // um id que não voltou é cartão apagado/ilegível: se NENHUM voltou, não deu para ler
    if (leads.length === 0) return null;
    return leads.map((l) => ({ nome: l.name, criadoEmEpoch: l.created_at ?? null }));
  } catch (err) {
    logger.warn({ err: String(err), leadId, contatoId }, `${ID}: não consegui ler os outros cartões do contato`);
    return null;
  }
}

/** Uma rodada numa conta do Kommo. Devolve o resumo (ou `null` se não havia nada a fazer). */
export async function tipoNaChegadaConta(ctx: ContextoDaConta): Promise<Resumo | null> {
  const { unit, membros, kommo, deps, agora } = ctx;
  if (!algumaChaveAtiva(unit, membros, deps.estadoDe)) return null;

  // O índice de telefones da franquia leva minutos para montar: pede já, mesmo sem cartão novo na janela. Só unidade com a
  // chave em seco ou ligada (as outras nunca gastam uma chamada da franquia por causa desta automação).
  for (const u of ctx.unidadesDaConta ?? [unit]) if (deps.estadoDe(u.slug) !== 'desligado') deps.garantirIndice(u);

  const { leads, truncado } = await kommo.listLeadsNaJanela('created_at', agora - JANELA_S, agora - IDADE_MINIMA_S, MAX_PAGINAS, true);
  if (truncado) logger.warn({ unit: unit.slug, leads: leads.length }, `${ID}: lista de cartões novos cortada — trato os mais recentes e o resto fica para quem agendar (campos-sdr)`);
  const candidatos = leads.filter((l) => !FECHADOS.has(l.status_id)).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id);
  if (candidatos.length === 0) return null;

  const campos = await kommo.listLeadCustomFieldsTyped();
  const campo = acharCampo(campos, CAMPO_TIPO_LEAD, true);
  if (!campo) {
    avisarUmaVez(unit.slug, `a conta não tem o campo "${CAMPO_TIPO_LEAD}" (ou tem dois com esse nome)`);
    return null;
  }
  const ehLista = campo.type === 'select' || campo.type === 'radiobutton';
  if (!ehLista) {
    avisarUmaVez(unit.slug, `o campo "${CAMPO_TIPO_LEAD}" é do tipo ${campo.type}, não lista — não gravo`);
    return null;
  }
  const campoPrimeiro = acharCampo(campos, CAMPO_PRIMEIRO_CONTATO);

  const resumo: Resumo = { candidatos: 0, gravados: 0, simulados: 0, desligados: 0, jaPreenchidos: 0, semUnidade: 0, adiados: 0, semOpcao: 0, emLote: 0, erros: 0 };
  // vazios de verdade: preenchido (qualquer valor, inclusive "Transferido de outra unidade") não é tocado
  const vazios = candidatos.filter((l) => {
    if (valorDoCampo(l, campo.id) === null) return true;
    resumo.jaPreenchidos++;
    return false;
  });
  // Importação em massa (carga da franquia, planilha) cria centenas de cartões "novos" de uma vez: não é chegada de lead.
  const emLote = cartoesCriadosEmLote(vazios);
  const doDia = vazios.filter((l) => !emLote.has(l.id));
  resumo.emLote = vazios.length - doDia.length;
  if (resumo.emLote > 0) avisarUmaVez(unit.slug, `${resumo.emLote} cartões criados em lote (importação) ficaram de fora — o campos-sdr os alcança no agendamento`);
  resumo.candidatos = doDia.length;
  if (doDia.length === 0) return resumo;

  // A unidade DONA de cada cartão (Petrópolis × Caxias: a ⌂ Unidade de atendimento; as outras, a própria). A decisão é guardada por
  // unidade+cartão: se a SDR corrigir a unidade, a decisão da outra franquia não vale.
  const alvos: Array<{ lead: KommoLead; donoUnit: Unit; estado: Estado; chave: string }> = [];
  for (const lead of doDia) {
    const dono = await deps.donoDoCartao(unit, lead).catch((err) => {
      logger.warn({ err: String(err), leadId: lead.id, unit: unit.slug }, `${ID}: não consegui saber a unidade do cartão`);
      return null;
    });
    if (!dono || dono.tipo === 'recusa') {
      // conta dividida sem ⌂ Unidade de atendimento (ou unidade sem franquia): o cartão ainda pode ganhar a unidade — olho de novo na próxima
      resumo.semUnidade++;
      continue;
    }
    const donoUnit = dono.unit as Unit;
    const estado = deps.estadoDe(donoUnit.slug);
    if (estado === 'desligado') {
      resumo.desligados++;
      continue;
    }
    alvos.push({ lead, donoUnit, estado, chave: `${donoUnit.id}|${lead.id}` });
  }

  // telefone e nome do contato, em lote — só dos que ainda precisam de decisão. Falhou: lança (quem chama registra e tenta de novo).
  const precisam = alvos.filter((a) => !decididos.has(a.chave)).map((a) => a.lead);
  const contatos: Map<number, { nome: string | null; telefone: string | null }> = precisam.length
    ? await kommo.contatosBasicos(precisam.map(contatoPrincipal).filter((n): n is number => n !== null))
    : new Map();

  // O paciente deste cartão foi criado por NÓS (Sofia ao agendar, widget "só cadastrar")? A busca na franquia o acharia e isso não é
  // "já existia". Erro ao conferir = adia (nunca decide às cegas): um Resgate por engano é permanente.
  const criadoPorNos = (a: { donoUnit: Unit; lead: KommoLead }) =>
    deps.pacienteCriadoPorNos(a.donoUnit.id, a.lead.id).catch((err) => {
      logger.warn({ err: String(err), leadId: a.lead.id, unit: a.donoUnit.slug }, `${ID}: não consegui conferir o vínculo do cartão — adio`);
      return true;
    });

  let avaliacoes = 0;
  let gravacoes = 0;
  let falhasSeguidas = 0;
  for (const alvo of alvos) {
    const { lead, donoUnit, estado, chave } = alvo;

    let decisao: Decidido | null | undefined = decididos.get(chave);
    if (!decisao) {
      const t = tentativas.get(chave);
      if (t && agora * 1000 < t.proxima) {
        resumo.adiados++;
        continue;
      }
      if (avaliacoes >= MAX_AVALIACOES_POR_RODADA) {
        resumo.adiados++;
        continue;
      }
      if (await criadoPorNos(alvo)) {
        resumo.adiados++;
        continue;
      }
      avaliacoes++;
      decisao = await avaliar({ kommo, deps, unit: donoUnit, lead, contatos, campoPrimeiro, agora });
      // a Sofia pode ter cadastrado o paciente enquanto a franquia era consultada: reconfere ANTES de aceitar a prova da franquia
      if (decisao?.viaFranquia && (await criadoPorNos(alvo))) decisao = null;
      if (!decisao) {
        const n = (tentativas.get(chave)?.n ?? 0) + 1;
        aparar(tentativas);
        tentativas.set(chave, { n, proxima: agora * 1000 + Math.min(ESPERA_MAX_MS, ESPERA_BASE_MS * n) });
        resumo.adiados++;
        continue;
      }
      aparar(decididos);
      decididos.set(chave, decisao);
    }

    const opcao = opcaoDaConta(campo.enums, decisao.tipo);
    if (!opcao) {
      resumo.semOpcao++;
      avisarUmaVez(donoUnit.slug, `a conta não tem a opção "${decisao.tipo}" no campo "${CAMPO_TIPO_LEAD}" — não gravo`);
      deps.registrar(donoUnit, ID, { leadId: lead.id, acao: 'pularia', alvo: CAMPO_TIPO_LEAD, valor: decisao.tipo, motivo: `a conta não tem a opção "${decisao.tipo}"` });
      continue;
    }

    if (estado === 'seco') {
      resumo.simulados++;
      deps.registrar(donoUnit, ID, { leadId: lead.id, acao: 'gravaria', alvo: CAMPO_TIPO_LEAD, valor: opcao, motivo: decisao.motivo });
      if (!anunciados.has(chave)) {
        aparar(anunciados);
        anunciados.add(chave);
        logger.info({ unit: donoUnit.slug, leadId: lead.id, valor: opcao, motivo: decisao.motivo }, `${ID} [seco]: gravaria "${opcao}" — ${decisao.motivo}`);
      }
      continue;
    }

    if (gravacoes >= MAX_GRAVACOES_POR_RODADA) {
      resumo.adiados++;
      continue;
    }
    gravacoes++;
    try {
      // decisão guardada de uma rodada anterior: a Sofia pode ter cadastrado o paciente desde então
      if (decisao.viaFranquia && (await criadoPorNos(alvo))) {
        decididos.delete(chave);
        resumo.adiados++;
        continue;
      }
      // a SDR pode ter escolhido enquanto líamos: relê antes de gravar. Vale o que já estiver lá.
      const atual = await kommo.getLead(lead.id);
      if (valorDoCampo(atual, campo.id) !== null) {
        resumo.jaPreenchidos++;
        logger.info({ unit: donoUnit.slug, leadId: lead.id }, `${ID}: o campo foi preenchido antes — não sobrescrevo`);
        continue;
      }
      await kommo.setLeadCustomFieldValue(lead.id, campo.id, campo.type, opcao, campo.enums);
      resumo.gravados++;
      falhasSeguidas = 0;
      logger.info({ unit: donoUnit.slug, leadId: lead.id, valor: opcao, motivo: decisao.motivo }, `${ID}: gravado "${opcao}" — ${decisao.motivo}`);
      await new Promise((r) => setTimeout(r, ctx.pausaMs ?? PAUSA_ENTRE_ESCRITAS_MS));
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: donoUnit.slug, leadId: lead.id }, `${ID}: falha ao gravar`);
      if (++falhasSeguidas >= 3) {
        logger.warn({ unit: unit.slug }, `${ID}: 3 falhas seguidas — paro esta rodada`);
        break;
      }
    }
  }
  if (resumo.gravados || resumo.simulados || resumo.erros || resumo.semOpcao) logger.info({ conta: unit.slug, ...resumo }, `${ID}: varredura`);
  return resumo;
}

/**
 * A decisão de UM cartão: idade (sem custo) → outros cartões do contato (Kommo) → franquia (uma busca). `null` = não dá
 * para decidir agora (e não é "Cadastro").
 */
async function avaliar(a: {
  kommo: KommoDoTipo;
  deps: DepsDoTipo;
  unit: Unit;
  lead: KommoLead;
  contatos: Map<number, { nome: string | null; telefone: string | null }>;
  campoPrimeiro: { id: number } | null;
  agora: number;
}): Promise<Decidido | null> {
  const { kommo, deps, unit, lead, contatos, campoPrimeiro } = a;
  const cid = contatoPrincipal(lead);
  const contato = cid !== null ? contatos.get(cid) ?? null : null;
  const primeiroContatoEpoch = campoPrimeiro ? dataDoCampo(valorDoCampo(lead, campoPrimeiro.id)) : null;
  const proprio = { nome: lead.name, criadoEmEpoch: lead.created_at ?? null, primeiroContatoEpoch };
  const temDataDeChegada = !!lead.created_at;

  // 1. só com o próprio cartão (nome com data, campo do 1º contato): sem custo
  let pelaIdade = resgatePelaIdade({ ...proprio, outros: [] });
  let outrosLidos = true;
  // 2. os outros cartões do mesmo contato (Kommo): 1º contato antigo em outro cartão
  if (!pelaIdade && cid !== null) {
    const outros = await outrosCartoesDoContato(kommo, cid, lead.id);
    if (outros === null) outrosLidos = false;
    else pelaIdade = resgatePelaIdade({ ...proprio, outros });
  }
  // 3. a franquia: uma busca, só se a idade não bastou
  let franquia: RespostaDaFranquia | null = null;
  if (!pelaIdade) {
    franquia = await deps.franquiaConhece(unit, { titulo: lead.name, nomeDoContato: contato?.nome ?? null, telefone: contato?.telefone ?? null, chegadaEpoch: lead.created_at ?? null }).catch(
      (err): RespostaDaFranquia => ({ resultado: 'desconhecido', motivo: `a franquia não respondeu (${String(err).slice(0, 120)})` }),
    );
  }
  const v = decidirTipoDaChegada({ pelaIdade, outrosLidos, franquia, temDataDeChegada });
  if (!v.tipo) {
    logger.info({ unit: unit.slug, leadId: lead.id, motivo: v.motivo }, `${ID}: ainda não decido — ${v.motivo}`);
    return null;
  }
  return { tipo: v.tipo, motivo: v.motivo, viaFranquia: !pelaIdade && franquia?.resultado === 'sim' };
}

export const depsPadrao: DepsDoTipo = {
  estadoDe: (slug) => estadoDaAutomacao(slug, ID, process.env.TIPO_LEAD_CHEGADA_SLUGS),
  donoDoCartao: (contaUnit, lead) => unidadeDoCartao(contaUnit, lead),
  async pacienteCriadoPorNos(unitId, leadId) {
    const l = await prisma.spineLeadLink.findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { spineIdSchedule: true, agendadoPara: true, spineIdClient: true, motivo: true },
    });
    if (!l) return false;
    if (l.spineIdSchedule || l.agendadoPara) return true;
    // vínculo com paciente: se foi o casamento (achou quem JÁ existia) é prova de Resgate e segue para a busca; qualquer outro
    // (widget "só cadastrar", agendamento) pode ser o paciente recém-criado
    return !!l.spineIdClient && !(l.motivo ?? '').startsWith(PREFIXO_PACIENTE_EXISTENTE);
  },
  franquiaConhece: (unit, e) => franquiaConhece(unit, e),
  garantirIndice: (unit) => agendarIndice(unit),
  registrar: registrarSimulacao,
};

// ── o laço ──────────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function varrerConta(daConta: Unit): Promise<void> {
  // Kommo dividido: quem tem as credenciais é a unidade DONA da conta
  const unit = (await contaDoKommo(daConta)) as Unit;
  if (!unit.kommoAccessToken) return;
  const grupo = await grupoDaUnidade(unit.id);
  const membros = grupo?.membros ?? null;
  // olha as chaves ANTES de abrir o cliente do Kommo: conta com tudo desligado não custa nada
  if (!algumaChaveAtiva(unit, membros, depsPadrao.estadoDe)) return;
  const unidadesDaConta = membros?.length ? await prisma.unit.findMany({ where: { id: { in: [...new Set(membros.map((m) => m.unitId))] } } }) : [unit];
  await tipoNaChegadaConta({ unit, membros, kommo: createKommoClient(unit), deps: depsPadrao, unidadesDaConta, agora: Math.floor(Date.now() / 1000) });
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    // Uma varredura por CONTA do Kommo (a dona tem as credenciais; a irmã, Caxias, entra pelo grupo).
    const vistas = new Set<string>();
    for (const u of units) {
      const conta = u.kommoSubdomain?.trim().toLowerCase();
      if (!conta || !u.kommoAccessToken || vistas.has(conta)) continue;
      vistas.add(conta);
      await varrerConta(u).catch((err) => logger.warn({ err: String(err), unit: u.slug }, `${ID}: varredura falhou`));
    }
  } finally {
    rodando = false;
  }
}

export function startTipoLeadChegadaWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID}: worker iniciado`);
}

export function stopTipoLeadChegadaWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
