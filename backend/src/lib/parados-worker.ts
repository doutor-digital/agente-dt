/**
 * Worker de leads PARADOS — quem move é o relógio e a franquia, não a equipe (João, 18 e 21/09/2026).
 *
 * As regras puras estão em `parados.ts`. Aqui: ler o Kommo e a franquia, decidir, mover, anotar.
 * Roda de hora em hora nas unidades de `PARADOS_SLUGS`; com `PARADOS_SECO=1` só registra o que
 * faria (sem cota: o modo seco mostra o estoque inteiro). Cada cartão movido ganha a etiqueta
 * `⏱ movido por prazo` e uma nota dizendo o porquê.
 *
 * Fontes de verdade e por que:
 *  - "o paciente escreveu nos últimos N dias": eventos `incoming_chat_message` do CONTATO PRINCIPAL,
 *    com janela (`created_at from`) — por lead a API dá 204 e a ordem da lista não é garantida;
 *  - "acabou de chegar na etapa": `lead_status_changed` do lead na janela;
 *  - franquia SEMPRE fresca (`GET /clients/{id}`, sem o cache de 1 h do sincronizador) antes de
 *    perder alguém: consulta futura ou tratamento aberto segura;
 *  - a etapa é relida logo antes de escrever: o sincronizador e a Sofia também movem.
 * Erro de API num cartão pula o cartão (nunca vira "paciente nunca escreveu").
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { esquemaDaUnidade, normalizarNome } from './kommo-schema.js';
import { ETAPA, ehEtapaDeEntrada, tratamentoAberto } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { carregarFunis, idClientDoLead, temConsultaFutura, type Funis } from './franquia-sync-worker.js';
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
  ehRespostaDeCortesia,
  modoSeco,
  paradosLiberado,
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
const MAX_PAGINAS = 4;

const funisCache = new Map<string, { em: number; funis: Funis }>();
async function funisDaUnidade(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

/** A etapa de entrada muda de nome ("Incoming leads" / "Etapa de leads de entrada"): pega pelo tipo 1, senão pelo nome. */
async function etapaDeEntrada(kommo: KommoClient, funis: Funis): Promise<{ pipelineId: number; statusId: number; nome: string } | null> {
  const pipes = await kommo.listPipelines();
  const comercial = pipes.find((p) => p.id === funis.comercialId);
  const s = comercial?.statuses?.find((x) => x.type === 1) ?? comercial?.statuses?.find((x) => ehEtapaDeEntrada(x.name));
  return s ? { pipelineId: funis.comercialId, statusId: s.id, nome: s.name } : null;
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
  const id = esquema.campoPorNome(nome);
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

async function etiquetarEAnotar(unit: Unit, kommo: KommoClient, leadId: number, texto: string, semRegua: boolean): Promise<void> {
  try {
    await kommo.addTag({ leadId, tags: semRegua ? [TAG_PRAZO, TAG_SEM_REGUA] : [TAG_PRAZO] });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao etiquetar');
  }
  try {
    await kommo.addLeadNote(leadId, texto);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'parados: falha ao anotar');
  }
}

/** Relê o cartão logo antes de escrever: se mudou de etapa nesse meio tempo, não mexe. */
async function aindaNaEtapa(kommo: KommoClient, funis: Funis, leadId: number, etapa: string): Promise<boolean> {
  const lead = await kommo.getLead(leadId);
  const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
  return !!atual && atual.funil === 'COMERCIAL' && normalizarNome(atual.status) === normalizarNome(etapa);
}

/**
 * O que a franquia sabe do paciente AGORA (sem cache): consulta futura ou tratamento aberto
 * seguram o cartão. `conhecido=false` = não achei o paciente (ou franquia desligada).
 */
async function franquiaSegura(unit: Unit, leadId: number, nome: string | null, agoraEpoch: number): Promise<{ conhecido: boolean; segura: boolean; motivo?: string }> {
  if (!unit.spineEnabled || !unit.spineToken) return { conhecido: false, segura: false };
  const idClient = await idClientDoLead(unit, leadId, nome);
  if (!idClient) return { conhecido: false, segura: false };
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) return { conhecido: false, segura: false };
  const { schedules, treatments } = r.data.client;
  if (treatments.some(tratamentoAberto)) return { conhecido: true, segura: true, motivo: 'tratamento aberto na franquia' };
  if (temConsultaFutura(schedules, agoraEpoch)) return { conhecido: true, segura: true, motivo: 'consulta futura na franquia' };
  return { conhecido: true, segura: false };
}

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

/** Fecha como PERDIDO com motivo + campo do cartão + etiquetas + nota. Em modo seco só registra. Devolve se moveu. */
export async function fecharComoPerdido(
  unit: Unit,
  kommo: KommoClient,
  funis: Funis,
  leadId: number,
  etapaAtual: string,
  d: DecisaoParado,
  seco: boolean,
): Promise<boolean> {
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra, motivo: d.motivoPerda };
  if (seco) {
    logger.info(base, 'parados [seco]: moveria pra PERDIDO');
    return false;
  }
  if (!(await aindaNaEtapa(kommo, funis, leadId, etapaAtual))) {
    logger.info(base, 'parados: cartão mudou de etapa enquanto eu decidia — não mexi');
    return false;
  }
  const lossId = d.motivoPerda ? await idDoMotivoDePerda(unit, kommo, d.motivoPerda).catch(() => null) : null;
  if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base, campo: d.campo?.nome }, 'parados: falha ao gravar o motivo no cartão'),
    );
  }
  await kommo.setLeadStatus(leadId, { won: false, lossReasonId: lossId ?? undefined });
  await etiquetarEAnotar(unit, kommo, leadId, textoDaNota(d, etapaAtual), d.semRegua === true);
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
): Promise<boolean> {
  const alvo = funis.idDe('COMERCIAL', ETAPA.ESPERA);
  const base = { unit: unit.slug, leadId, de: etapaAtual, regra: d.regra };
  if (!alvo) {
    logger.warn(base, 'parados: a conta não tem a etapa EM ESPERA — não movi');
    return false;
  }
  if (seco) {
    logger.info(base, 'parados [seco]: moveria pra EM ESPERA');
    return false;
  }
  if (!(await aindaNaEtapa(kommo, funis, leadId, etapaAtual))) {
    logger.info(base, 'parados: cartão mudou de etapa enquanto eu decidia — não mexi');
    return false;
  }
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
  await etiquetarEAnotar(unit, kommo, leadId, textoDaNota(d, etapaAtual), false);
  logger.warn(base, 'parados: cartão movido pra EM ESPERA');
  return true;
}

/**
 * Regra 8 (18/09): paciente em EM ESPERA que escreve DE VERDADE volta pra EM QUALIFICAÇÃO na hora,
 * e a retomada automática é cancelada (limpa "Retomar em"). Chamado pelo webhook depois de todas
 * as travas e esperado (o turno já vê a etapa nova). Nunca lança.
 */
export async function voltarDaEsperaSeRespondeu(unit: Unit, leadId: number, mensagem: string | null | undefined): Promise<void> {
  if (!paradosLiberado(unit.slug) || !unit.kommoAccessToken) return;
  if (ehRespostaDeCortesia(mensagem)) return;
  try {
    const kommo = createKommoClient(unit);
    const lead = await kommo.getLead(leadId);
    const funis = await funisDaUnidade(unit, kommo);
    if (!funis) return;
    const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
    if (!atual || atual.funil !== 'COMERCIAL' || !ehEspera(atual.status)) return;
    const alvo = funis.idDe('COMERCIAL', ETAPA.QUALIFICACAO);
    if (!alvo) return;
    if (modoSeco()) {
      logger.info({ unit: unit.slug, leadId }, 'parados [seco]: voltaria de EM ESPERA pra EM QUALIFICAÇÃO (paciente escreveu)');
      return;
    }
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
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
  seco: boolean;
  avaliados: number;
  candidatos: number;
  movidos: number;
  segurosPelaFranquia: number;
  erros: number;
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

async function varrerUnidade(unit: Unit): Promise<Resumo> {
  const seco = modoSeco();
  const resumo: Resumo = { unit: unit.slug, seco, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  const agora = Math.floor(Date.now() / 1000);
  const kommo = createKommoClient(unit);
  const funis = await funisDaUnidade(unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'parados: não achei o funil COMERCIAL — pulei a unidade');
    return resumo;
  }
  // A cota é por REGRA e só conta movimento de verdade: o modo seco mostra o estoque inteiro.
  const cotaNova = () => {
    let feitos = 0;
    return { tem: () => seco || feitos < MAX_POR_VARREDURA, conta: (moveu: boolean) => void (moveu && feitos++) };
  };

  // ── EM ESPERA / EM NEGOCIAÇÃO: quieto por N dias, sem retomada pendente, sem fato novo na franquia ──
  for (const etapa of [ETAPA.ESPERA, ETAPA.NEGOCIACAO]) {
    const alvo = funis.idDe('COMERCIAL', etapa);
    const prazo = prazoDaEtapa(etapa);
    if (!alvo || prazo === null) continue;
    const cota = cotaNova();
    const desde = agora - prazo * DIA_S;
    for (const lead of await leadsDaEtapa(kommo, alvo.pipelineId, alvo.statusId)) {
      if (!cota.tem()) break;
      resumo.avaliados++;
      try {
        const cartao = { retomarEmEpoch: epochDoCampoData(lead, CAMPO.RETOMAR_EM), criadoEpoch: lead.created_at ?? null };
        if (!candidatoPeloCartao(etapa, cartao, agora)) continue; // barato: sem chamada nenhuma
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
        const moveu = await fecharComoPerdido(unit, kommo, funis, lead.id, etapa, d, seco);
        cota.conta(moveu);
        if (moveu) {
          resumo.movidos++;
          await pausa();
        }
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etapa }, 'parados: erro num cartão — pulei');
      }
    }
  }

  // ── NÃO COMPARECEU: faltou há 7 dias e a franquia (fresca) não tem consulta futura → EM ESPERA ──
  {
    const alvo = funis.idDe('COMERCIAL', ETAPA.NAO_COMPARECEU);
    const cota = cotaNova();
    for (const lead of alvo ? await leadsDaEtapa(kommo, alvo.pipelineId, alvo.statusId) : []) {
      if (!cota.tem()) break;
      resumo.avaliados++;
      try {
        const situacao = normalizarNome(String(valorDoCampo(lead, CAMPOS_SYNC.SITUACAO) ?? ''));
        if (!situacao.includes(normalizarNome('não compareceu'))) continue;
        const dataFalta = epochDoCampoData(lead, CAMPOS_SYNC.DATA_CONSULTA);
        if (!decidirFalta(dataFalta, false, agora)) continue; // ainda dentro do prazo: nem consulta a franquia
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
        const moveu = await moverParaEspera(unit, kommo, funis, lead.id, ETAPA.NAO_COMPARECEU, d, seco);
        cota.conta(moveu);
        if (moveu) {
          resumo.movidos++;
          await pausa();
        }
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'parados: erro num cartão de falta — pulei');
      }
    }
  }

  // ── Entrada / EM QUALIFICAÇÃO: régua esgotada ("Sem resposta" no cartão) e 24 h sem resposta ──
  {
    const entrada = await etapaDeEntrada(kommo, funis).catch(() => null);
    const qualif = funis.idDe('COMERCIAL', ETAPA.QUALIFICACAO);
    const etapas = [
      ...(entrada ? [{ ...entrada }] : []),
      ...(qualif ? [{ ...qualif, nome: ETAPA.QUALIFICACAO }] : []),
    ];
    const cota = cotaNova();
    const desde = agora - PRAZOS.reguaRespostaHoras * 3600;
    for (const e of etapas) {
      if (!reguaEsgotadaDerruba(e.nome)) continue;
      for (const lead of await leadsDaEtapa(kommo, e.pipelineId, e.statusId)) {
        if (!cota.tem()) break;
        const status = valorDoCampo(lead, CAMPO.STATUS_CONVERSA);
        if (!decidirReguaEsgotada(status == null ? null : String(status), false)) continue; // só quem já está "Sem resposta"
        resumo.avaliados++;
        try {
          const contato = contatoPrincipal(lead);
          const escreveu = contato !== null && (await kommo.contatoEscreveuDesde(contato, desde));
          const d = decidirReguaEsgotada(String(status), escreveu);
          if (!d) continue;
          resumo.candidatos++;
          const f = await franquiaSegura(unit, lead.id, lead.name ?? null, agora);
          if (f.segura) {
            resumo.segurosPelaFranquia++;
            continue;
          }
          const moveu = await fecharComoPerdido(unit, kommo, funis, lead.id, e.nome, d, seco);
          cota.conta(moveu);
          if (moveu) {
            resumo.movidos++;
            await pausa();
          }
        } catch (err) {
          resumo.erros++;
          logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, etapa: e.nome }, 'parados: erro num cartão da régua — pulei');
        }
      }
    }
  }

  logger.info(resumo, 'parados: varredura da unidade');
  return resumo;
}

let rodando = false;
async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true } });
    for (const u of units) {
      if (!paradosLiberado(u.slug) || !u.kommoAccessToken || !u.kommoSubdomain) continue;
      await varrerUnidade(u).catch((err) => logger.warn({ err: String(err), unit: u.slug }, 'parados: unidade falhou'));
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
    { sweepMs: SWEEP_MS, slugs: process.env.PARADOS_SLUGS ?? '', seco: modoSeco(), maxPorRegra: MAX_POR_VARREDURA },
    'parados worker iniciado',
  );
}

export function stopParadosWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
