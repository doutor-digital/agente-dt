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
import { ETAPA, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
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
const MAX_PAGINAS = 8;
/** Cartões que chegam a gastar chamada de Kommo/franquia por regra por varredura (vale no modo seco também). */
const MAX_AVALIACOES = Number(process.env.PARADOS_MAX_AVALIACOES) || MAX_POR_VARREDURA * 5;

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

/** O mesmo campo tem nome curto no cartão enxuto e longo nas contas antigas (Serra: "…do tratamento"). */
const NOMES_ALTERNATIVOS: Record<string, readonly string[]> = {
  [CAMPO.MOTIVO_NAO_FECHAMENTO]: ['⊘ Motivo de não fechamento do tratamento'],
};

async function gravarSelect(unit: Unit, kommo: KommoClient, leadId: number, nome: string, opcao: string): Promise<void> {
  const esquema = await esquemaDaUnidade(unit, kommo);
  const id = [nome, ...(NOMES_ALTERNATIVOS[nome] ?? [])].map((x) => esquema.campoPorNome(x)).find((x) => x !== null) ?? null;
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

/** Relê o cartão logo antes de escrever: se mudou de etapa nesse meio tempo, não mexe. */
async function aindaNaEtapa(kommo: KommoClient, funis: Funis, leadId: number, etapa: string): Promise<boolean> {
  const lead = await kommo.getLead(leadId);
  const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
  return !!atual && atual.funil === 'COMERCIAL' && normalizarNome(atual.status) === normalizarNome(etapa);
}

/**
 * O que a franquia sabe do paciente AGORA (sem cache): consulta futura ou tratamento EM ANDAMENTO
 * seguram o cartão. `conhecido=false` = não achei o paciente (ou franquia desligada).
 */
async function franquiaSegura(unit: Unit, leadId: number, nome: string | null, agoraEpoch: number): Promise<{ conhecido: boolean; segura: boolean; motivo?: string }> {
  if (!unit.spineEnabled || !unit.spineToken) return { conhecido: false, segura: false };
  const idClient = await idClientDoLead(unit, leadId, nome);
  if (!idClient) return { conhecido: false, segura: false };
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) return { conhecido: false, segura: false };
  const { schedules, treatments } = r.data.client;
  if (treatments.some((t) => t.idStatus === TRATAMENTO_EM_ANDAMENTO)) return { conhecido: true, segura: true, motivo: 'tratamento em andamento na franquia' };
  if (temConsultaFutura(schedules, agoraEpoch)) return { conhecido: true, segura: true, motivo: 'consulta futura na franquia' };
  return { conhecido: true, segura: false };
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
  // Etiqueta ANTES de mudar o status: o gatilho de PERDIDO (not_equal NO_FOLLOW_UP) lê a condição no evento.
  await etiquetar(unit, kommo, leadId, d.semRegua === true);
  if (d.campo) {
    await gravarSelect(unit, kommo, leadId, d.campo.nome, d.campo.opcao).catch((err) =>
      logger.warn({ err: String(err), ...base, campo: d.campo?.nome }, 'parados: falha ao gravar o motivo no cartão'),
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
 */
export async function voltarDaEsperaSeRespondeu(unit: Unit, leadId: number, mensagem: string | null | undefined): Promise<void> {
  if (!paradosLiberado(unit.slug) || !unit.kommoAccessToken) return;
  if (ehRespostaDeCortesia(mensagem)) return;
  try {
    const est = await estadoEtapaDoLead(unit, leadId);
    if (!est?.nome || !ehEspera(est.nome)) return;
    const kommo = createKommoClient(unit);
    const funis = await funisDaUnidade(unit, kommo);
    const alvo = funis?.idDe('COMERCIAL', ETAPA.QUALIFICACAO);
    if (!alvo) return;
    if (modoSeco()) {
      logger.info({ unit: unit.slug, leadId }, 'parados [seco]: voltaria de EM ESPERA pra EM QUALIFICAÇÃO (paciente escreveu)');
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

async function varrerConta(unit: Unit, unidadesDaConta: Unit[]): Promise<Resumo> {
  const seco = modoSeco();
  const conta = unit.kommoSubdomain ?? unit.slug;
  const resumo: Resumo = { unit: unit.slug, conta, seco, avaliados: 0, candidatos: 0, movidos: 0, segurosPelaFranquia: 0, erros: 0 };
  const agora = Math.floor(Date.now() / 1000);
  const kommo = createKommoClient(unit);
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
  {
    const alvo = funis.idDe('COMERCIAL', ETAPA.NAO_COMPARECEU);
    const cota = cotaNova(seco);
    for (const lead of alvo ? await leadsDaEtapa(kommo, alvo.pipelineId, alvo.statusId) : []) {
      const situacao = normalizarNome(String(valorDoCampo(lead, CAMPOS_SYNC.SITUACAO) ?? ''));
      if (!situacao.includes(normalizarNome('não compareceu'))) continue;
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
    const limite = new Date((agora - PRAZOS.reguaRespostaHoras * 3600) * 1000);
    const convs = await prisma.conversation.findMany({
      where: {
        unitId: { in: unidadesDaConta.map((u) => u.id) },
        followUpStep: { gte: 1 },
        followUpStoppedReason: null,
        followUpLastAt: { lt: limite },
      },
      orderBy: { followUpLastAt: 'desc' },
      take: MAX_AVALIACOES,
      select: { leadId: true, followUpLastAt: true },
    });
    for (const c of convs) {
      const leadId = Number(c.leadId);
      if (!Number.isFinite(leadId) || leadId <= 0 || !c.followUpLastAt) continue;
      if (!cota.podeAvaliar()) break;
      cota.avaliou();
      resumo.avaliados++;
      try {
        const lead = await kommo.getLead(leadId);
        const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
        if (!atual || atual.funil !== 'COMERCIAL' || !reguaEsgotadaDerruba(atual.status)) continue;
        const status = valorDoCampo(lead, CAMPO.STATUS_CONVERSA);
        if (!decidirReguaEsgotada(status == null ? null : String(status), false)) continue; // a escada ainda não acabou
        const ultimoToque = Math.floor(c.followUpLastAt.getTime() / 1000);
        const contato = contatoPrincipal(lead);
        const escreveu = contato !== null && (await kommo.contatoEscreveuDesde(contato, ultimoToque));
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

  logger.info(resumo, 'parados: varredura da conta');
  return resumo;
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
