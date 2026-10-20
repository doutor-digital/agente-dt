/**
 * Worker de leads PARADOS — quem move é o relógio e a franquia, não a equipe (João, 18 e 21/09/2026).
 *
 * As regras puras estão em `parados.ts`. Aqui: ler o Kommo, o banco do agente e a franquia,
 * decidir, mover, anotar. Roda de hora em hora nas contas Kommo de `PARADOS_SLUGS` (uma varredura
 * por CONTA, não por unidade — comercial e resgate dividem a conta); com `PARADOS_SECO=1` só
 * registra o que faria. Cada cartão movido ganha a etiqueta `⏱ movido por prazo` e uma nota.
 *
 * Fontes de verdade e por que:
 *  - "o paciente escreveu desde X": eventos `incoming_chat_message` do CONTATO PRINCIPAL, com
 *    janela (`created_at from`) — por lead a API dá 204 e a ordem da lista não é garantida;
 *  - "acabou de chegar na etapa": `lead_status_changed` do lead na janela;
 *  - régua esgotada: o banco do agente diz QUANDO saiu o último toque (`followUpLastAt`); o cartão
 *    diz que a escada acabou ("⬢ Status da conversa = Sem resposta"); as 24 h contam do toque;
 *  - franquia SEMPRE fresca (`GET /clients/{id}`, sem o cache de 1 h do sincronizador) antes de
 *    perder alguém: consulta futura ou tratamento EM ANDAMENTO seguram (proposta pendente não —
 *    é justamente o público de "sem resposta após consulta");
 *  - a etapa é relida logo antes de escrever: o sincronizador e a Sofia também movem;
 *  - etiquetas ANTES do status: os gatilhos de PERDIDO avaliam a condição no evento.
 * Erro de API num cartão pula o cartão (nunca vira "paciente nunca escreveu"). Cada regra avalia no
 * máximo `MAX_AVALIACOES` cartões caros por varredura (também no modo seco — 7 req/s é o teto do Kommo).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { estadoEtapaDoLead, invalidarEtapa } from '../services/lead-stage.service.js';
import { esquemaDaUnidade, normalizarNome } from './kommo-schema.js';
import { ETAPA, TRATAMENTO_EM_ANDAMENTO, ehEtapaDeEntrada, tratamentoFinalizado, type Funil } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDividida, grupoDaUnidade, pularCartao, unidadeDonaDoCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { carregarFunis, idClientDoLead, temConsultaFutura, type Funis } from './franquia-sync-worker.js';
import { diaDaRetomada, diaDoCampoData, esperaSeguraVolta, retomarEmDoCartao } from './espera-retomada.js';
import {
  ID_AUTOMACAO_ESTOQUES,
  PRAZOS_ESTOQUE,
  candidatoConsultaVelha,
  candidatoDormente,
  candidatoFaltaDoEstoque,
  classeDoTratamentoSemDado,
  decidirAgendadoParado,
  decidirDormente,
  decidirFaltaDoEstoque,
  decidirRetornoParado,
  estadoDosEstoques,
  semDadoDeSessao,
} from './parados-estoques.js';
import { semearFilaDeAlta } from './semear-fila-de-alta.js';
import {
  CAMPO,
  DIA_S,
  MAX_POR_VARREDURA,
  PRAZOS,
  TAG_PRAZO,
  TAG_SEM_REGUA,
  candidatoPeloCartao,
  decidirFalta,
  decidirParado,
  decidirReguaEsgotada,
  ehEspera,
  filtroDaReguaEsgotada,
  ehRespostaDeCortesia,
  modoSeco,
  motivoDaSdrNoCartao,
  nomesDoCampo,
  paradosLiberado,
  voltaDaEsperaLiberada,
  voltaDaEsperaSeca,
  prazoDaEtapa,
  reguaEsgotadaDerruba,
  textoDaNota,
  type DecisaoParado,
} from './parados.js';

const SWEEP_MS = Number(process.env.PARADOS_SWEEP_MS) || 60 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const FUNIS_TTL_MS = 10 * 60_000;
const MOTIVOS_TTL_MS = 60 * 60_000;
const MAX_PAGINAS = 8;
/** Cartões que chegam a gastar chamada de Kommo/franquia por regra por varredura (vale no modo seco também). */
const MAX_AVALIACOES = Number(process.env.PARADOS_MAX_AVALIACOES) || MAX_POR_VARREDURA * 5;
/** Escadas concluídas lidas do banco por varredura (as mais recentes primeiro); os cartões vêm em lotes de 50. */
const MAX_CONVERSAS_DA_REGUA = Number(process.env.PARADOS_MAX_CONVERSAS_REGUA) || 1000;

const funisCache = new Map<string, { em: number; funis: Funis }>();
async function funisDaUnidade(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

const motivosCache = new Map<string, { em: number; porNome: Map<string, number> }>();
/** Id do motivo de perda pelo NOME; cria na conta se não existir (contas novas não têm todos). */
async function idDoMotivoDePerda(unit: Unit, kommo: KommoClient, nome: string): Promise<number | null> {
  let hit = motivosCache.get(unit.id);
  if (!hit || Date.now() - hit.em >= MOTIVOS_TTL_MS) {
    const lista = await kommo.listLossReasons();
    hit = { em: Date.now(), porNome: new Map(lista.map((m) => [normalizarNome(m.name), m.id])) };
    motivosCache.set(unit.id, hit);
  }
  const chave = normalizarNome(nome);
  const id = hit.porNome.get(chave);
  if (id) return id;
  const criado = await kommo.createLossReason(nome);
  if (criado) {
    hit.porNome.set(chave, criado.id);
    logger.info({ unit: unit.slug, motivo: nome, id: criado.id }, 'parados: motivo de perda criado na conta');
    return criado.id;
  }
  return null;
}

function valorDoCampo(lead: KommoLead, nome: string): unknown {
  const alvo = normalizarNome(nome);
  const f = (lead.custom_fields_values ?? []).find((c) => normalizarNome(c.field_name ?? '') === alvo);
  return f?.values?.[0]?.value;
}

/** Campo de data do Kommo vem como epoch (s) — mas aceita ms e ISO por segurança. */
function epochDoCampoData(lead: KommoLead, nome: string): number | null {
  const v = valorDoCampo(lead, nome);
  if (v == null || v === '') return null;
  const num = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(num) && num > 0) return num > 1e11 ? Math.floor(num / 1000) : num;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function contatoPrincipal(lead: KommoLead): number | null {
  const cs = lead._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
}

async function gravarSelect(unit: Unit, kommo: KommoClient, leadId: number, nome: string, opcao: string): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = nomesDoCampo(nome).map((x) => esquema.campoPorNome(x)).find((x) => x !== null) ?? null;
  if (id === null) {
    logger.warn({ unit: unit.slug, leadId, campo: nome }, 'parados: campo não existe nesta conta — segui sem ele');
    return;
  }
  await kommo.setLeadCustomFieldValue(leadId, id, 'select', opcao);
}

async function gravarData(unit: Unit, kommo: KommoClient, leadId: number, nome: string, epoch: number): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return;
  await kommo.setLeadCustomFieldValue(leadId, id, 'date', new Date(epoch * 1000).toISOString());
}

async function limparCampo(unit: Unit, kommo: KommoClient, leadId: number, nome: string): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = esquema.campoPorNome(nome);
  if (id === null) return;
  await kommo.clearLeadCustomField(leadId, id);
}

async function etiquetar(unit: Unit, kommo: KommoClient, leadId: number, semRegua: boolean): Promise<void> {
  try {
    await kommo.addTag({ leadId, tags: semRegua ? [TAG_PRAZO, TAG_SEM_REGUA] : [TAG_PRAZO] });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao etiquetar');
  }
}

async function anotar(unit: Unit, kommo: KommoClient, leadId: number, texto: string): Promise<void> {
  try {
    await kommo.addLeadNote(leadId, texto);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao anotar');
  }
}

/** Relê o cartão logo antes de escrever: se mudou de etapa nesse meio tempo, não mexe (null). */
async function aindaNaEtapa(kommo: KommoClient, funis: Funis, leadId: number, etapa: string): Promise<KommoLead | null> {
  const lead = await kommo.getLead(leadId);
  const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
  return atual && atual.funil === 'COMERCIAL' && normalizarNome(atual.status) === normalizarNome(etapa) ? lead : null;
}

/** O que a franquia sabe do paciente AGORA (sem cache). `conhecido=false` = não achei o paciente (ou franquia desligada). */
export interface NaFranquia {
  conhecido: boolean;
  consultaFutura: boolean;
  emAndamento: boolean;
  finalizado: boolean;
}

/**
 * `GET /clients/{id}` fresco. Erro da API LANÇA: "a franquia caiu" não pode virar "paciente não achado" — as regras
 * do estoque movem quem a franquia não conhece, e o resto do worker perde quem ela não segura.
 */
export async function franquiaDoPaciente(unit: Unit, leadId: number, nome: string | null, agoraEpoch: number): Promise<NaFranquia> {
  const nada: NaFranquia = { conhecido: false, consultaFutura: false, emAndamento: false, finalizado: false };
  if (!unit.spineEnabled || !unit.spineToken) return nada;
  const idClient = await idClientDoLead(unit, leadId, nome);
  if (!idClient) return nada;
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok) throw new Error(`franquia não respondeu (paciente ${idClient}): ${r.error ?? 'erro'}`);
  if (!r.data?.client) return nada;
  const { schedules, treatments } = r.data.client;
  return {
    conhecido: true,
    consultaFutura: temConsultaFutura(schedules, agoraEpoch),
    emAndamento: treatments.some((t) => t.idStatus === TRATAMENTO_EM_ANDAMENTO),
    finalizado: treatments.some((t) => tratamentoFinalizado({ idStatus: t.idStatus, statusName: t.statusName })),
  };
}

/** Consulta futura ou tratamento EM ANDAMENTO seguram o cartão (proposta pendente não — é o público de "sem resposta após consulta"). */
async function franquiaSegura(unit: Unit, leadId: number, nome: string | null, agoraEpoch: number): Promise<{ conhecido: boolean; segura: boolean; motivo?: string }> {
  const f = await franquiaDoPaciente(unit, leadId, nome, agoraEpoch);
  if (f.emAndamento) return { conhecido: true, segura: true, motivo: 'tratamento em andamento na franquia' };
  if (f.consultaFutura) return { conhecido: true, segura: true, motivo: 'consulta futura na franquia' };
  return { conhecido: f.conhecido, segura: false };
}

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

/** Fecha como PERDIDO: etiquetas → motivo no cartão → status com loss reason → nota. Em modo seco só registra. */
export async function fecharComoPerdido(
  unit: Unit,
  kommo: KommoClient,
  funis: Funis,
  leadId: number,
  etapaAtual: string,
  d: DecisaoParado,
  seco: boolean,
  automacao: string = 'parados',
): Promise<boolean> {
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra, motivo: d.motivoPerda };
  if (seco) {
    logger.info({ ...base, automacao }, 'parados [seco]: moveria pra PERDIDO');
    registrarSimulacao(unit, automacao, { leadId, acao: 'moveria', alvo: ETAPA.PERDIDO, deEtapa: etapaAtual, valor: d.motivoPerda, motivo: d.regra });
    return false;
  }
  const lead = await aindaNaEtapa(kommo, funis, leadId, etapaAtual);
  if (!lead) {
    logger.info(base, 'parados: cartão mudou de etapa enquanto eu decidia — não mexi');
    return false;
  }
  const lossId = d.motivoPerda ? await idDoMotivoDePerda(unit, kommo, d.motivoPerda).catch(() => null) : null;
  // Etiqueta ANTES de mudar o status: o gatilho de PERDIDO (not_equal NO_FOLLOW_UP) lê a condição no evento.
  await etiquetar(unit, kommo, leadId, d.semRegua === true);
  const motivoDaSdr = d.campo ? motivoDaSdrNoCartao(lead.custom_fields_values) : null;
  if (motivoDaSdr) {
    logger.info({ ...base, campo: d.campo?.nome, valor: motivoDaSdr }, 'parados: o cartão já tinha motivo — mantive o da SDR');
  } else if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base, campo: d.campo?.nome, opcao: d.campo?.opcao }, 'parados: falha ao gravar o motivo no cartão (a opção existe no campo desta conta?)'),
    );
  }
  await kommo.setLeadStatus(leadId, { won: false, lossReasonId: lossId ?? undefined });
  invalidarEtapa(unit.id, leadId);
  await anotar(unit, kommo, leadId, textoDaNota(d, etapaAtual));
  logger.warn({ ...base, lossId }, 'parados: cartão movido pra PERDIDO');
  return true;
}

/** NÃO COMPARECEU → EM ESPERA com motivo "Outro" e retomada marcada. Devolve se moveu. */
export async function moverParaEspera(
  unit: Unit,
  kommo: KommoClient,
  funis: Funis,
  leadId: number,
  etapaAtual: string,
  d: DecisaoParado,
  seco: boolean,
  automacao: string = 'parados',
): Promise<boolean> {
  const alvo = funis.idDe('COMERCIAL', ETAPA.ESPERA);
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra };
  if (!alvo) {
    logger.warn(base, 'parados: a conta não tem a etapa EM ESPERA — não movi');
    return false;
  }
  if (seco) {
    logger.info({ ...base, automacao }, 'parados [seco]: moveria pra EM ESPERA');
    registrarSimulacao(unit, automacao, { leadId, acao: 'moveria', alvo: ETAPA.ESPERA, deEtapa: etapaAtual, motivo: d.regra });
    return false;
  }
  if (!(await aindaNaEtapa(kommo, funis, leadId, etapaAtual))) {
    logger.info(base, 'parados: cartão mudou de etapa enquanto eu decidia — não mexi');
    return false;
  }
  await etiquetar(unit, kommo, leadId, false);
  if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base }, 'parados: falha ao gravar o motivo da espera'),
    );
  }
  if (d.retomarEmEpoch) {
    await gravarData(unit, kommo, leadId, CAMPO.RETOMAR_EM, d.retomarEmEpoch).catch((err) =>
      logger.warn({ err: String(err), ...base }, 'parados: falha ao gravar "Retomar em"'),
    );
  }
  await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
  invalidarEtapa(unit.id, leadId);
  await anotar(unit, kommo, leadId, textoDaNota(d, etapaAtual));
  logger.warn(base, 'parados: cartão movido pra EM ESPERA');
  return true;
}

/**
 * Regra 8 (18/09): paciente em EM ESPERA que escreve DE VERDADE volta pra EM QUALIFICAÇÃO na hora,
 * e a retomada automática é cancelada (limpa "Retomar em"). Chamado pelo webhook, esperado. Lê a
 * etapa pelo cache de 90 s do prompt (`estadoEtapaDoLead`): fora de EM ESPERA não custa chamada
 * nenhuma a mais. Nunca lança.
 *
 * Liga por `VOLTA_ESPERA_SLUGS`, não por `PARADOS_SLUGS`: é a única regra do worker que não move
 * ninguém por prazo — só reage ao paciente escrever — então serve de rede para SDR que estaciona
 * cartão cedo demais sem trazer junto a régua de PERDIDO. Ver `voltaDaEsperaLiberada`.
 */
export async function voltarDaEsperaSeRespondeu(unit: Unit, leadId: number, mensagem: string | null | undefined): Promise<void> {
  if (!unit.kommoAccessToken) return;
  // Kommo dividido (Petrópolis + Caxias): a mensagem chega pela dona da conta, mas a chave que vale é a da unidade
  // do CARTÃO. Kommo de uma unidade só: o portão barato de sempre, sem chamada nenhuma.
  const grupo = await grupoDaUnidade(unit.id);
  const dividido = !!grupo;
  if (!dividido && !voltaDaEsperaLiberada(unit.slug)) return;
  // dividido: só gasta chamada se a chave de alguma unidade do grupo estiver ligada (ou em seco)
  if (grupo && !grupo.membros.some((m) => m.slug && voltaDaEsperaLiberada(m.slug))) return;
  if (ehRespostaDeCortesia(mensagem)) return;
  try {
    const est = await estadoEtapaDoLead(unit, leadId);
    if (!est?.nome || !ehEspera(est.nome)) return;
    const kommo = createKommoClient(unit);
    const lead = await kommo.getLead(leadId);
    const dona = dividido ? await unidadeDonaDoCartao(unit, lead) : unit;
    if (!dona || !voltaDaEsperaLiberada(dona.slug)) return; // cartão sem unidade: ninguém mexe
    // Auditoria 16/10 (item 10): EM ESPERA com ◷ Retomar em pra frente foi decisão da SDR (ou da Sofia, no mesmo
    // turno) — o paciente escrever não desfaz a espera. A Sofia conversa em EM ESPERA do mesmo jeito; no dia da
    // retomada, a resposta à mensagem de retomada traz o cartão de volta como sempre.
    const retomarEm = retomarEmDoCartao(lead.custom_fields_values);
    if (esperaSeguraVolta(diaDaRetomada(retomarEm, Math.floor(Date.now() / 1000), dona.spineTimezone))) {
      logger.info({ unit: dona.slug, leadId, retomarEm: retomarEm ? diaDoCampoData(retomarEm) : null }, 'parados: paciente escreveu em EM ESPERA com ◷ Retomar em marcado — o cartão fica');
      return;
    }
    const funis = await funisDaUnidade(unit, kommo);
    const alvo = funis?.idDe('COMERCIAL', ETAPA.QUALIFICACAO);
    if (!alvo) return;
    if (voltaDaEsperaSeca(dona.slug)) {
      logger.info({ unit: dona.slug, leadId }, 'parados [seco]: voltaria de EM ESPERA pra EM QUALIFICAÇÃO (paciente escreveu)');
      registrarSimulacao(dona, 'volta-espera', { leadId, acao: 'moveria', alvo: ETAPA.QUALIFICACAO, deEtapa: est.nome, motivo: 'paciente voltou a escrever' });
      return;
    }
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
    invalidarEtapa(unit.id, leadId);
    await limparCampo(unit, kommo, leadId, CAMPO.RETOMAR_EM).catch(() => undefined);
    await kommo
      .addLeadNote(leadId, '↩ Voltou de EM ESPERA para EM QUALIFICAÇÃO: o paciente escreveu. Retomada automática cancelada.')
      .catch(() => null);
    logger.info({ unit: unit.slug, leadId }, 'parados: paciente respondeu — voltou de EM ESPERA');
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao voltar de EM ESPERA (ignorada)');
  }
}

interface Resumo {
  unit: string;
  conta: string;
  seco: boolean;
  avaliados: number;
  candidatos: number;
  movidos: number;
  segurosPelaFranquia: number;
  erros: number;
  /** Kommo dividido: cartões da outra unidade (não são desta varredura) */
  deOutraUnidade?: number;
  /** Kommo dividido: cartões sem «⌂ Unidade de atendimento» — ninguém mexe */
  semUnidade?: number;
}

async function leadsDaEtapa(kommo: KommoClient, pipelineId: number, statusId: number): Promise<KommoLead[]> {
  const out: KommoLead[] = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const pag = await kommo.listLeadsPorEtapa(pipelineId, statusId, 250, page, true);
    out.push(...pag);
    if (pag.length < 250) break;
  }
  return out;
}

/** Cota por regra: `MAX_POR_VARREDURA` movimentos de verdade e `MAX_AVALIACOES` cartões caros (Kommo/franquia). */
function cotaNova(seco: boolean) {
  let movidos = 0;
  let avaliados = 0;
  return {
    podeAvaliar: () => avaliados < MAX_AVALIACOES && (seco || movidos < MAX_POR_VARREDURA),
    avaliou: () => void avaliados++,
    moveu: () => void movidos++,
  };
}

async function varrerConta(unit: Unit, unidadesDaConta: Unit[], dividida?: { kommoDe: Unit; grupo: GrupoDoCrm }): Promise<Resumo> {
  const seco = modoSeco(unit.slug);
  const conta = dividida?.kommoDe.kommoSubdomain ?? unit.kommoSubdomain ?? unit.slug;
  const resumo: Resumo = { unit: unit.slug, conta, seco, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  const agora = Math.floor(Date.now() / 1000);
  // Kommo dividido: o cliente é o da dona da conta; a chave, o token da franquia e os cartões são DESTA unidade.
  const kommo = createKommoClient(dividida?.kommoDe ?? unit);
  const grupo = dividida?.grupo ?? null;
  const funis = await funisDaUnidade(unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'parados: não achei o funil COMERCIAL — pulei a conta');
    return resumo;
  }
  const registrar = async (moveu: boolean, cota: ReturnType<typeof cotaNova>) => {
    if (moveu) {
      cota.moveu();
      resumo.movidos++;
      await pausa();
    }
  };

  // ── EM ESPERA / EM NEGOCIAÇÃO: quieto por N dias, sem retomada pendente, sem fato novo na franquia ──
  for (const etapa of [ETAPA.ESPERA, ETAPA.NEGOCIACAO]) {
    const alvo = funis.idDe('COMERCIAL', etapa);
    const prazo = prazoDaEtapa(etapa);
    if (!alvo || prazo === null) continue;
    const cota = cotaNova(seco);
    const desde = agora - prazo * DIA_S;
    for (const lead of await leadsDaEtapa(kommo, alvo.pipelineId, alvo.statusId)) {
      const cartao = { retomarEmEpoch: epochDoCampoData(lead, CAMPO.RETOMAR_EM), criadoEpoch: lead.created_at ?? null };
      if (!candidatoPeloCartao(etapa, cartao, agora)) continue; // barato: sem chamada nenhuma
      if (pularCartao(grupo, unit.id, lead, resumo)) continue; // Kommo dividido: só os cartões desta unidade
      if (!cota.podeAvaliar()) break;
      cota.avaliou();
      resumo.avaliados++;
      try {
        const contato = contatoPrincipal(lead);
        if (contato !== null && (await kommo.contatoEscreveuDesde(contato, desde))) continue;
        if (await kommo.leadMudouEtapaDesde(lead.id, desde)) continue;
        const d = decidirParado(etapa, { ...cartao, escreveuNaJanela: false, mudouEtapaNaJanela: false }, agora);
        if (!d) continue;
        resumo.candidatos++;
        const f = await franquiaSegura(unit, lead.id, lead.name ?? null, agora);
        if (f.segura) {
          resumo.segurosPelaFranquia++;
          logger.info({ unit: unit.slug, leadId: lead.id, etapa, motivo: f.motivo }, 'parados: prazo venceu, mas a franquia segura o cartão');
          continue;
        }
        await registrar(await fecharComoPerdido(unit, kommo, funis, lead.id, etapa, d, seco), cota);
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etapa }, 'parados: erro num cartão — pulei');
      }
    }
  }

  // ── NÃO COMPARECEU: faltou há 7 dias e a franquia (fresca) não tem consulta futura → EM ESPERA ──
  // Com a chave dos estoques LIGADA, quem cuida da etapa inteira é a regra do estoque (abaixo), que inclui esta.
  const estoques = estadoDosEstoques(unit.slug);
  if (estoques !== 'ligado') {
    const alvo = funis.idDe('COMERCIAL', ETAPA.NAO_COMPARECEU);
    const cota = cotaNova(seco);
    for (const lead of alvo ? await leadsDaEtapa(kommo, alvo.pipelineId, alvo.statusId) : []) {
      const situacao = normalizarNome(String(valorDoCampo(lead, CAMPOS_SYNC.SITUACAO) ?? ''));
      if (!situacao.includes(normalizarNome('não compareceu'))) continue;
      if (pularCartao(grupo, unit.id, lead, resumo)) continue; // Kommo dividido: só os cartões desta unidade
      const dataFalta = epochDoCampoData(lead, CAMPOS_SYNC.DATA_CONSULTA);
      if (!decidirFalta(dataFalta, false, agora)) continue; // ainda dentro do prazo: nem consulta a franquia
      if (!cota.podeAvaliar()) break;
      cota.avaliou();
      resumo.avaliados++;
      try {
        const f = await franquiaSegura(unit, lead.id, lead.name ?? null, agora);
        if (!f.conhecido) {
          logger.info({ unit: unit.slug, leadId: lead.id }, 'parados: falta sem paciente achado na franquia — não movi');
          continue;
        }
        const d = decidirFalta(dataFalta, f.segura, agora);
        if (!d) {
          resumo.segurosPelaFranquia++;
          continue;
        }
        resumo.candidatos++;
        await registrar(await moverParaEspera(unit, kommo, funis, lead.id, ETAPA.NAO_COMPARECEU, d, seco), cota);
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'parados: erro num cartão de falta — pulei');
      }
    }
  }

  // ── Régua esgotada: o banco do agente diz quando saiu o último toque; o cartão diz que a escada acabou ──
  {
    const cota = cotaNova(seco);
    const convs = await prisma.conversation.findMany({
      where: filtroDaReguaEsgotada(unidadesDaConta.map((u) => u.id), agora),
      orderBy: { followUpLastAt: 'desc' },
      take: MAX_CONVERSAS_DA_REGUA,
      select: { leadId: true, followUpLastAt: true },
    });
    // Os cartões vêm em lote (50 por chamada) e a etapa filtra de graça: medido na Açailândia em 20/10, 263 das 273
    // escadas concluídas já estavam em PERDIDO (régua do Kommo ou SDR). Pedir cartão por cartão gastava a cota das
    // avaliações caras com eles, varredura após varredura, e o cartão que ainda estava na porta nunca era olhado.
    const ultimoToque = new Map<number, number>();
    for (const c of convs) {
      const leadId = Number(c.leadId);
      if (Number.isFinite(leadId) && leadId > 0 && c.followUpLastAt && !ultimoToque.has(leadId)) ultimoToque.set(leadId, Math.floor(c.followUpLastAt.getTime() / 1000));
    }
    let leads: KommoLead[] = [];
    try {
      leads = ultimoToque.size ? await kommo.listLeadsPorIds([...ultimoToque.keys()], { contatos: true }) : [];
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: unit.slug }, 'parados: não li os cartões da régua esgotada — pulei a regra nesta varredura');
    }
    const porId = new Map(leads.map((l) => [l.id, l]));
    for (const [leadId, toque] of ultimoToque) {
      const lead = porId.get(leadId);
      if (!lead) continue; // cartão apagado, ou de outra conta
      if (pularCartao(grupo, unit.id, lead, resumo)) continue; // Kommo dividido: só os cartões desta unidade
      const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
      if (!atual || atual.funil !== 'COMERCIAL' || !reguaEsgotadaDerruba(atual.status)) continue;
      const status = valorDoCampo(lead, CAMPO.STATUS_CONVERSA);
      if (!decidirReguaEsgotada(status == null ? null : String(status), false)) continue; // o cartão não diz "Sem resposta"
      if (!cota.podeAvaliar()) break;
      cota.avaliou();
      resumo.avaliados++;
      try {
        const contato = contatoPrincipal(lead);
        const escreveu = contato !== null && (await kommo.contatoEscreveuDesde(contato, toque));
        const d = decidirReguaEsgotada(String(status), escreveu);
        if (!d) continue;
        resumo.candidatos++;
        const f = await franquiaSegura(unit, lead.id, lead.name ?? null, agora);
        if (f.segura) {
          resumo.segurosPelaFranquia++;
          continue;
        }
        await registrar(await fecharComoPerdido(unit, kommo, funis, lead.id, atual.status, d, seco), cota);
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: erro num cartão da régua — pulei');
      }
    }
  }

  // ── Estoques que nenhuma regra alcançava (auditoria 16/10, item 11): chave própria, nasce desligada ──
  if (estoques !== 'desligado') {
    await varrerEstoques({ unit, kommo, unidadesDaConta, agora }, funis, grupo, resumo, seco || estoques === 'seco');
  }

  logger.info(resumo, 'parados: varredura da conta');
  return resumo;
}

// ─── Estoques (auditoria da Açailândia, 16/10/2026, item 11) ─────────────────────────────────────

export type RegraDoEstoque = 'falta' | 'agendado' | 'retorno' | 'tratamento' | 'dormente';

export interface EtapaDoEstoque {
  regra: RegraDoEstoque;
  funil: Funil;
  pipelineId: number;
  statusId: number;
  nome: string;
}

/** As etapas que cada regra do estoque varre nesta conta (pelo NOME; a entrada tem nome variável por conta). */
export function etapasDoEstoque(funis: Funis): EtapaDoEstoque[] {
  const out: EtapaDoEstoque[] = [];
  const add = (regra: RegraDoEstoque, funil: Funil, etapa: string) => {
    const id = funis.idDe(funil, etapa);
    if (id) out.push({ regra, funil, ...id, nome: etapa });
  };
  add('falta', 'COMERCIAL', ETAPA.NAO_COMPARECEU);
  add('agendado', 'COMERCIAL', ETAPA.AGENDADO);
  add('retorno', 'COMERCIAL', ETAPA.RETORNO);
  add('tratamento', 'TRATAMENTO', ETAPA.EM_TRATAMENTO);
  for (const [chave, s] of funis.status) {
    if (chave.startsWith('COMERCIAL:') && ehEtapaDeEntrada(s.nome)) out.push({ regra: 'dormente', funil: 'COMERCIAL', pipelineId: funis.comercialId, statusId: s.id, nome: s.nome });
  }
  add('dormente', 'COMERCIAL', ETAPA.QUALIFICACAO);
  return out;
}

/** Barato, só com o cartão: vale gastar chamada com ele? */
export function candidatoDoEstoque(regra: RegraDoEstoque, lead: KommoLead, etapa: string, agora: number, tz: string): boolean {
  const data = epochDoCampoData(lead, CAMPOS_SYNC.DATA_CONSULTA);
  const retomada = diaDaRetomada(retomarEmDoCartao(lead.custom_fields_values), agora, tz);
  if (regra === 'falta') return candidatoFaltaDoEstoque(String(valorDoCampo(lead, CAMPOS_SYNC.SITUACAO) ?? ''), data, retomada, agora);
  if (regra === 'agendado' || regra === 'retorno') return candidatoConsultaVelha(data, retomada, agora);
  if (regra === 'tratamento') return semDadoDeSessao(lead.custom_fields_values) && (lead.created_at ?? agora) < agora - PRAZOS_ESTOQUE.paradoDias * DIA_S;
  return candidatoDormente(etapa, lead.created_at ?? null, data, retomada, agora);
}

export interface AvaliacaoDoEstoque {
  regra: RegraDoEstoque;
  leadId: number;
  etapa: string;
  /** mover (PERDIDO ou EM ESPERA) */
  decisao: DecisaoParado | null;
  /** EM TRATAMENTO: entra na fila da página /alta, a recepção decide */
  filaDeAlta: 'ALTA' | 'PAROU' | null;
  /** por que fica (pro log e pro script de conferência) */
  fica: string | null;
}

export interface CtxDoEstoque {
  unit: Unit;
  kommo: KommoClient;
  /** as unidades da conta Kommo (a conversa no agente pode estar em qualquer uma) */
  unidadesDaConta: Unit[];
  agora: number;
}

/**
 * Caro, SÓ LEITURA: lê eventos do Kommo, o banco do agente e a franquia (fresca) e decide. Não escreve nada —
 * é o mesmo caminho do worker e do script de conferência (`scripts/limpeza-estoques.ts`). Erro de API lança.
 */
export async function avaliarDoEstoque(ctx: CtxDoEstoque, regra: RegraDoEstoque, lead: KommoLead, etapa: string): Promise<AvaliacaoDoEstoque> {
  const { unit, kommo, agora } = ctx;
  const base = { regra, leadId: lead.id, etapa, decisao: null, filaDeAlta: null, fica: null } as AvaliacaoDoEstoque;
  const fica = (motivo: string): AvaliacaoDoEstoque => ({ ...base, fica: motivo });
  const contato = contatoPrincipal(lead);
  const semMudarDesde = async (dias: number) => !(await kommo.leadMudouEtapaDesde(lead.id, agora - dias * DIA_S));
  const semEscreverDesde = async (dias: number) => contato === null || !(await kommo.contatoEscreveuDesde(contato, agora - dias * DIA_S));
  const naFranquia = () => franquiaDoPaciente(unit, lead.id, lead.name ?? null, agora);
  const data = epochDoCampoData(lead, CAMPOS_SYNC.DATA_CONSULTA);

  if (regra === 'falta') {
    const semMudarEtapa = data === null ? await semMudarDesde(PRAZOS_ESTOQUE.paradoDias) : true;
    if (!semMudarEtapa) return fica('sem data e mudou de etapa há menos de 30 dias');
    const f = await naFranquia();
    const d = decidirFaltaDoEstoque({ dataFaltaEpoch: data, semMudarEtapa, franquiaSegura: f.consultaFutura || f.emAndamento, agora });
    return d ? { ...base, decisao: d } : fica(f.consultaFutura ? 'consulta futura na franquia' : f.emAndamento ? 'tratamento em andamento na franquia' : 'falta recente');
  }

  if (regra === 'agendado' || regra === 'retorno') {
    if (!(await semMudarDesde(PRAZOS_ESTOQUE.paradoDias))) return fica('mudou de etapa há menos de 30 dias');
    if (!(await semEscreverDesde(PRAZOS_ESTOQUE.paradoDias))) return fica('o paciente escreveu nos últimos 30 dias');
    const f = await naFranquia();
    const fatos = { dataConsultaEpoch: data, semMudarEtapa: true, semEscrever: true, franquiaSegura: f.consultaFutura || f.emAndamento, agora };
    const d = regra === 'agendado' ? decidirAgendadoParado(fatos) : decidirRetornoParado(fatos);
    return d ? { ...base, decisao: d } : fica(f.consultaFutura ? 'consulta futura na franquia' : f.emAndamento ? 'tratamento em andamento na franquia' : 'consulta recente');
  }

  if (regra === 'tratamento') {
    const naFila = await prisma.altaCandidato.findFirst({ where: { unitId: unit.id, leadId: lead.id }, select: { id: true } });
    if (naFila) return fica('já está na fila da página /alta');
    if (!(await semMudarDesde(PRAZOS_ESTOQUE.paradoDias))) return fica('mudou de etapa há menos de 30 dias');
    const f = await naFranquia();
    const classe = classeDoTratamentoSemDado({ semMudarEtapa: true, conhecido: f.conhecido, emAndamento: f.emAndamento, finalizado: f.finalizado });
    return classe ? { ...base, filaDeAlta: classe } : fica('tratamento em andamento na franquia');
  }

  // dormente: entrada / EM QUALIFICAÇÃO
  const desde = new Date((agora - PRAZOS_ESTOQUE.dormenteDias * DIA_S) * 1000);
  const conversa = await prisma.conversation.findFirst({
    where: { unitId: { in: ctx.unidadesDaConta.map((u) => u.id) }, leadId: String(lead.id), lastMessageAt: { gt: desde } },
    select: { id: true },
  });
  if (conversa) return fica('conversa com a IA nos últimos 90 dias');
  if (!(await semMudarDesde(PRAZOS_ESTOQUE.dormenteDias))) return fica('mudou de etapa nos últimos 90 dias');
  if (!(await semEscreverDesde(PRAZOS_ESTOQUE.dormenteDias))) return fica('o paciente escreveu nos últimos 90 dias');
  const f = await naFranquia();
  const d = decidirDormente({ semMudarEtapa: true, semEscrever: true, conversaRecente: false, franquiaSegura: f.consultaFutura || f.emAndamento });
  return d ? { ...base, decisao: d } : fica(f.consultaFutura ? 'consulta futura na franquia' : 'tratamento em andamento na franquia');
}

/** Aplica (ou, em seco, registra) o que a avaliação decidiu. Devolve se mexeu de verdade. */
export async function aplicarDoEstoque(ctx: CtxDoEstoque, funis: Funis, a: AvaliacaoDoEstoque, lead: KommoLead, seco: boolean): Promise<boolean> {
  const { unit, kommo } = ctx;
  if (a.decisao?.para === 'PERDIDO') return fecharComoPerdido(unit, kommo, funis, a.leadId, a.etapa, a.decisao, seco, ID_AUTOMACAO_ESTOQUES);
  if (a.decisao?.para === 'EM ESPERA') return moverParaEspera(unit, kommo, funis, a.leadId, a.etapa, a.decisao, seco, ID_AUTOMACAO_ESTOQUES);
  if (a.filaDeAlta) {
    const motivo = a.filaDeAlta === 'ALTA' ? 'em EM TRATAMENTO sem dado de sessão, tratamento finalizado na franquia' : 'em EM TRATAMENTO sem nenhum dado de sessão da franquia';
    if (seco) {
      registrarSimulacao(unit, ID_AUTOMACAO_ESTOQUES, { leadId: a.leadId, acao: 'alertaria', alvo: 'fila da página /alta', valor: a.filaDeAlta, deEtapa: a.etapa, motivo });
      return false;
    }
    await semearFilaDeAlta(unit.id, [{ leadId: a.leadId, nome: lead.name ?? null, classe: a.filaDeAlta, realizadas: 0, previstas: 0, ultimaSessao: null }]);
    logger.info({ unit: unit.slug, leadId: a.leadId, classe: a.filaDeAlta }, 'parados: EM TRATAMENTO sem dado da franquia — entrou na fila da /alta');
    return true;
  }
  return false;
}

async function varrerEstoques(ctx: CtxDoEstoque, funis: Funis, grupo: GrupoDoCrm | null, resumo: Resumo, seco: boolean): Promise<void> {
  const { unit, agora } = ctx;
  const cotas = new Map<RegraDoEstoque, ReturnType<typeof cotaNova>>();
  for (const e of etapasDoEstoque(funis)) {
    const cota = cotas.get(e.regra) ?? cotaNova(seco);
    cotas.set(e.regra, cota);
    for (const lead of await leadsDaEtapa(ctx.kommo, e.pipelineId, e.statusId)) {
      if (!candidatoDoEstoque(e.regra, lead, e.nome, agora, unit.spineTimezone)) continue; // barato: sem chamada nenhuma
      if (pularCartao(grupo, unit.id, lead, resumo)) continue; // Kommo dividido: só os cartões desta unidade
      if (!cota.podeAvaliar()) break;
      cota.avaliou();
      resumo.avaliados++;
      try {
        const a = await avaliarDoEstoque(ctx, e.regra, lead, e.nome);
        if (!a.decisao && !a.filaDeAlta) continue;
        resumo.candidatos++;
        if (await aplicarDoEstoque(ctx, funis, a, lead, seco)) {
          cota.moveu();
          resumo.movidos++;
          await pausa();
        }
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, regra: e.regra }, 'parados: erro num cartão do estoque — pulei');
      }
    }
  }
}

let rodando = false;
async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    // Uma varredura por CONTA Kommo: a primeira unidade ligada da conta faz o trabalho pelas irmãs.
    const porConta = new Map<string, { dona: Unit; todas: Unit[] }>();
    for (const u of units) {
      const conta = u.kommoSubdomain?.trim().toLowerCase();
      if (!conta) continue;
      const grupo = porConta.get(conta) ?? { dona: u, todas: [] };
      grupo.todas.push(u);
      if (!paradosLiberado(grupo.dona.slug) && paradosLiberado(u.slug)) grupo.dona = u;
      porConta.set(conta, grupo);
    }
    for (const { dona, todas } of porConta.values()) {
      // Kommo dividido (Petrópolis + Caxias): cada unidade varre a conta com a SUA chave e o SEU token e só mexe nos
      // cartões do seu rótulo. A irmã não tem Kommo próprio (nem subdomínio), por isso entra por aqui e não acima.
      const dividida = await contaDividida(todas);
      if (dividida) {
        if (!dividida.conta.kommoAccessToken) continue;
        for (const m of dividida.membros) {
          if (!paradosLiberado(m.slug)) continue;
          await varrerConta(m, todas, { kommoDe: dividida.conta, grupo: dividida.grupo }).catch((err) => logger.warn({ err: String(err), unit: m.slug }, 'parados: conta falhou'));
        }
        continue;
      }
      if (!paradosLiberado(dona.slug) || !dona.kommoAccessToken) continue;
      await varrerConta(dona, todas).catch((err) => logger.warn({ err: String(err), unit: dona.slug }, 'parados: conta falhou'));
    }
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startParadosWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(
    { sweepMs: SWEEP_MS, slugs: process.env.PARADOS_SLUGS ?? '', seco: modoSeco(), maxPorRegra: MAX_POR_VARREDURA, maxAvaliacoes: MAX_AVALIACOES },
    'parados worker iniciado',
  );
}

export function stopParadosWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
