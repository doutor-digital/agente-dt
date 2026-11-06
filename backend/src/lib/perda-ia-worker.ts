/**
 * Os dois robôs que leem a conversa para tratar PERDIDO (pedido do João, 06/11/2026). Regras em `perda-ia.ts`.
 *
 *  - `motivo-perdido-ia`: cartão que ENTROU em PERDIDO (últimas 24 h) com o ⊘ Motivo do não agendamento vazio → a IA lê a
 *    conversa e grava a opção da lista DA CONTA que casa. É a mesma leitura e o mesmo classificador do botão «Sugerir
 *    motivo» do widget. Nunca sobrescreve; sem opção adequada, não grava nada.
 *  - `perda-ia`: cartão ABERTO em EM QUALIFICAÇÃO ou EM ESPERA cujo paciente disse, com clareza, que não quer / não é da região /
 *    foi engano → PERDIDO com motivo, etiqueta e nota. Quem move é o MESMO fecho do `parados` (`fecharOuSegurar`): etiquetas
 *    antes do status, motivo no cartão, trava da perda automática, nota. Vácuo (padrão 3) NÃO move aqui: é do `parados`.
 *
 * NÃO COMPARECEU fica de fora de propósito: quem faltou tem consulta na franquia e é jornada do `franquia-move` / dos estoques
 * do `parados`; "não quero mais" dito depois de uma falta costuma ser reagendamento. Entrada (leads novos) também: é da Sofia.
 *
 * Seco: decide e registra («moveria» / «gravaria» / «pularia») na tela e no log, sem escrever no Kommo — a leitura da IA RODA
 * (centavos), só a escrita não. Teto por unidade por varredura (avaliações com IA e movimentos); o que passa do teto entra na
 * varredura seguinte. Falha de leitura, de IA ou da franquia = o cartão fica onde está.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { carregarFunis, type Funis } from './franquia-sync-worker.js';
import { ETAPA } from './franquia-move.js';
import { CAMPO } from './parados.js';
import type { DecisaoParado } from './parados.js';
import { fecharOuSegurar, franquiaDoPaciente } from './parados-worker.js';
import { contaDividida, pularCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { etiquetaDeNaoContatar } from './sofia-fecha-quente-morno.js';
import { CAMPO_MOTIVO_NAO_AGENDAMENTO, interpretarResposta, montarPrompt, type FalaDaConversa } from './sugestao-motivo.js';
import { lerFalasDoCartao, transcreverAudios } from './conversa-do-cartao.js';
import {
  ID_MOTIVO_PERDIDO_IA,
  ID_PERDA_IA,
  ROTULO_DO_PADRAO,
  TAG_PERDA_IA,
  classificarPerda,
  linhaDoTempo,
  motivoTrabalhavel,
  perguntarAoModelo,
  porQueNaoAvaliar,
  type DecisaoDaPerda,
} from './perda-ia.js';
import { PERDIDO, porQueNaoPreencherMotivo, porQueOCartaoFica } from './perda-ia-cartao.js';

const SWEEP_MS = Number(process.env.PERDA_IA_SWEEP_MS) || 60 * 60_000;
const PRIMEIRA_VARREDURA_MS = 5 * 60_000;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const FUNIS_TTL_MS = 10 * 60_000;
const CAMPO_TTL_MS = 10 * 60_000;
/** Cartão já avaliado (e que ficou) não volta a gastar leitura de conversa + IA por um dia. */
const VISTO_TTL_MS = 24 * 60 * 60_000;
const MAX_PAGINAS_ETAPA = 8;
/** Falhas SEGUIDAS da IA que encerram a varredura da unidade (sem chave, Anthropic fora): não adianta bater 20 vezes. */
const FALHAS_DA_IA_QUE_ENCERRAM = 3;
const MAX_AUDIOS = 3;
/** Quantas horas o paciente tem de estar sem escrever para o cartão ser candidato à perda-ia. */
export const HORAS_SEM_PACIENTE = Number(process.env.PERDA_IA_HORAS) || 48;
/** Teto por unidade por varredura: cartões lidos com IA, e movimentos (no papel conta igual: o que o João confere é o que ligado faria). */
export const MAX_AVALIACOES = Number(process.env.PERDA_IA_MAX_AVALIACOES) || 20;
export const MAX_MOVIMENTOS = Number(process.env.PERDA_IA_MAX_MOVIMENTOS) || 5;
export const MAX_MOTIVOS = Number(process.env.MOTIVO_PERDIDO_IA_MAX) || 20;
/** Teto de conversas LIDAS no Kommo por unidade por varredura (1 a 6 chamadas cada), com ou sem IA: o limitador do Kommo é da rede toda. */
export const MAX_LEITURAS = MAX_AVALIACOES * 3;

const estadoPerda = (slug: string) => estadoDaAutomacao(slug, ID_PERDA_IA, process.env.PERDA_IA_SLUGS);
const estadoMotivo = (slug: string) => estadoDaAutomacao(slug, ID_MOTIVO_PERDIDO_IA, process.env.MOTIVO_PERDIDO_IA_SLUGS);

/** Erro que não passa sozinho (conta sem o escopo de chats responde 403 sempre): vale esperar o dia. Queda do Kommo/franquia tenta na varredura seguinte. */
const erroPermanente = (err: unknown) => /\b403\b|Invalid scope/i.test(String(err));

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

// ─── cache pequeno ────────────────────────────────────────────────────────────────────────────────

const funisCache = new Map<string, { em: number; funis: Funis }>();
async function funisDaConta(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

const camposCache = new Map<string, { em: number; campo: { id: number; enums: Array<{ id: number; value: string }> } | null }>();
async function campoDoMotivo(unit: Unit, kommo: KommoClient) {
  const hit = camposCache.get(unit.id);
  if (hit && Date.now() - hit.em < CAMPO_TTL_MS) return hit.campo;
  const campos = await kommo.listLeadCustomFieldsTyped();
  const f = campos.find((x) => x.name.trim() === CAMPO_MOTIVO_NAO_AGENDAMENTO) ?? null;
  const campo = f && f.enums.length ? { id: f.id, enums: f.enums } : null;
  camposCache.set(unit.id, { em: Date.now(), campo });
  return campo;
}

/** `unit:automacao:lead` → até quando não olhar de novo. Em memória: um deploy zera, e o custo disso é UMA releitura barata. */
const vistoAte = new Map<string, number>();
function jaVisto(unit: Unit, automacao: string, leadId: number): boolean {
  const k = `${unit.id}:${automacao}:${leadId}`;
  const ate = vistoAte.get(k);
  if (ate && ate > Date.now()) return true;
  if (ate) vistoAte.delete(k);
  return false;
}
function marcarVisto(unit: Unit, automacao: string, leadId: number): void {
  if (vistoAte.size > 20_000) for (const [k, ate] of vistoAte) if (ate <= Date.now()) vistoAte.delete(k);
  vistoAte.set(`${unit.id}:${automacao}:${leadId}`, Date.now() + VISTO_TTL_MS);
}

interface Resumo {
  unit: string;
  automacao: string;
  seco: boolean;
  candidatos: number;
  avaliados: number;
  moveria: number;
  gravados: number;
  vacuo: number;
  seguradosPelaFranquia: number;
  erros: number;
  custoUsd: number;
  deOutraUnidade?: number;
  semUnidade?: number;
}
const resumoNovo = (unit: Unit, automacao: string, seco: boolean): Resumo => ({
  unit: unit.slug, automacao, seco, candidatos: 0, avaliados: 0, moveria: 0, gravados: 0, vacuo: 0, seguradosPelaFranquia: 0, erros: 0, custoUsd: 0,
});

// ─── perda-ia: detecta e move ─────────────────────────────────────────────────────────────────────

/** A decisão do modelo vestida de fecho do `parados`: mesma etiqueta-antes-do-status, mesmo motivo, mesma trava, nota própria. */
export function decisaoDeFecho(d: Extract<DecisaoDaPerda, { tipo: 'mover' }>, etapa: string, etiquetaNaoContatar: string | null): DecisaoParado {
  const semRegua = !motivoTrabalhavel(d.motivo);
  const padrao = ROTULO_DO_PADRAO[d.padrao];
  return {
    para: 'PERDIDO',
    regra: `a IA leu a conversa (${padrao}): ${d.justificativa}`,
    dias: 0,
    motivoPerda: d.motivo,
    campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: d.motivo },
    semRegua,
    etiquetas: [TAG_PERDA_IA, ...(semRegua && etiquetaNaoContatar ? [etiquetaNaoContatar] : [])],
    nota:
      `Movido de ${etapa} para PERDIDO pela IA, que leu a conversa. Padrão: ${padrao}. Motivo: ${d.motivo}. ` +
      `Justificativa: ${d.justificativa} Frase do paciente: «${d.frase}». ` +
      `${semRegua ? 'Etiqueta de não contatar aplicada: a régua de PERDIDO não manda mensagem. ' : 'Pode receber a régua de PERDIDO da conta. '}` +
      'Se o paciente voltar a escrever, a Sofia retoma.',
  };
}

const ETAPAS_DA_PERDA = [ETAPA.QUALIFICACAO, ETAPA.ESPERA] as const;

/**
 * Os cartões abertos da etapa, do MAIS NOVO ao mais velho, até o teto de páginas: recusa recente está nos cartões recentes, e o
 * estoque antigo é do `parados`. (`leadsDaEtapa` lê do mais velho e, com o teto, cortaria justamente os novos.) Erro do Kommo lança.
 */
async function cartoesDaEtapa(kommo: KommoClient, pipelineId: number, statusId: number): Promise<KommoLead[]> {
  const out: KommoLead[] = [];
  for (let page = 1; page <= MAX_PAGINAS_ETAPA; page++) {
    const pag = await kommo.listLeadsPorEtapa(pipelineId, statusId, 250, page, true, 'desc');
    out.push(...pag);
    if (pag.length < 250) break;
  }
  return out;
}

interface CtxPerda {
  unit: Unit;
  kommo: KommoClient;
  funis: Funis;
  grupo: GrupoDoCrm | null;
  /** as unidades da conta Kommo: a conversa no agente pode estar em qualquer uma */
  unidadesDaConta: Unit[];
  /** o campo «Pausar IA» da conta (na conta dividida mora na dona, não na unidade da varredura) */
  pausarIaFieldId: number | null;
  seco: boolean;
  agora: number;
  opcoes: string[];
}

/** Uma varredura da perda-ia numa conta. Exportada para o teste. */
export async function varrerPerda(ctx: CtxPerda, resumo: Resumo): Promise<void> {
  const { unit, kommo, funis, grupo, seco, agora } = ctx;
  const tz = unit.spineTimezone;

  // 1) o barato: o próprio cartão
  const candidatos: Array<{ lead: KommoLead; etapa: string }> = [];
  for (const etapa of ETAPAS_DA_PERDA) {
    const alvo = funis.idDe('COMERCIAL', etapa);
    if (!alvo) continue;
    for (const lead of await cartoesDaEtapa(kommo, alvo.pipelineId, alvo.statusId)) {
      if (pularCartao(grupo, unit.id, lead, resumo)) continue; // Kommo dividido: só os cartões desta unidade
      if (jaVisto(unit, ID_PERDA_IA, lead.id)) continue;
      if (porQueOCartaoFica(lead, { agoraEpoch: agora, tz, pausarIaFieldId: ctx.pausarIaFieldId })) continue;
      candidatos.push({ lead, etapa });
    }
  }
  // os que mexeram há pouco primeiro: é onde uma recusa recente está; o estoque velho é do `parados`
  candidatos.sort((a, b) => (b.lead.updated_at ?? 0) - (a.lead.updated_at ?? 0));

  // 2) o barato do nosso banco: quem nunca escreveu não tem recusa a provar (e não gasta leitura no Kommo)
  const ids = candidatos.map((c) => String(c.lead.id));
  const comFala = new Set(
    ids.length
      ? (await prisma.conversation.findMany({ where: { unitId: { in: ctx.unidadesDaConta.map((u) => u.id) }, leadId: { in: ids }, messages: { some: { role: 'user' } } }, select: { leadId: true } })).map((c) => c.leadId)
      : [],
  );
  const fila = candidatos.filter((c) => comFala.has(String(c.lead.id)));
  resumo.candidatos = fila.length;

  // 3) o caro: ler a conversa e a IA, no teto
  let falhasDaIa = 0;
  let leituras = 0;
  for (const { lead, etapa } of fila) {
    if (resumo.avaliados >= MAX_AVALIACOES || resumo.moveria >= MAX_MOVIMENTOS || leituras >= MAX_LEITURAS) break;
    if (falhasDaIa >= FALHAS_DA_IA_QUE_ENCERRAM) {
      logger.warn({ unit: unit.slug }, 'perda-ia: a IA falhou várias vezes seguidas — encerrei a varredura desta unidade');
      break;
    }
    try {
      leituras++;
      const { falas } = await lerFalasDoCartao(kommo, lead.id);
      const linha = linhaDoTempo(falas, agora, tz);
      const naoAvalia = porQueNaoAvaliar(linha, HORAS_SEM_PACIENTE);
      if (naoAvalia) {
        marcarVisto(unit, ID_PERDA_IA, lead.id);
        logger.debug({ unit: unit.slug, leadId: lead.id, motivo: naoAvalia }, 'perda-ia: não avaliei');
        continue;
      }
      await transcreverAudios(unit, falas, MAX_AUDIOS);
      resumo.avaliados++;
      const { decisao, resposta, custoUsd } = await classificarPerda(unit, falas, ctx.opcoes, linha, { tz });
      resumo.custoUsd += custoUsd;
      logger.info(
        { unit: unit.slug, leadId: lead.id, etapa, seco, perdido: resposta?.perdido ?? null, padrao: resposta?.padrao ?? null, confianca: resposta?.confianca ?? null, decisao: decisao.tipo, porque: decisao.tipo === 'nada' ? decisao.porque : undefined },
        'perda-ia: leitura',
      );
      if (!resposta) {
        falhasDaIa++; // a IA falhou: não marca visto, tenta na próxima varredura
        continue;
      }
      falhasDaIa = 0;
      marcarVisto(unit, ID_PERDA_IA, lead.id);

      if (decisao.tipo === 'vacuo') {
        resumo.vacuo++;
        if (seco) registrarSimulacao(unit, ID_PERDA_IA, { leadId: lead.id, acao: 'pularia', alvo: ETAPA.PERDIDO, deEtapa: etapa, valor: 'vácuo', motivo: `vácuo prolongado: quem move é o parados (régua esgotada / EM ESPERA 30 d). ${decisao.justificativa}` });
        continue;
      }
      if (decisao.tipo === 'nada') {
        if (seco && resposta.perdido === 'sim') registrarSimulacao(unit, ID_PERDA_IA, { leadId: lead.id, acao: 'pularia', alvo: ETAPA.PERDIDO, deEtapa: etapa, motivo: `a IA disse perdido, as travas seguraram: ${decisao.porque}` });
        continue;
      }

      // a franquia manda: consulta futura ou tratamento em andamento lá seguram (erro lança: franquia fora do ar ≠ "livre")
      const f = await franquiaDoPaciente(unit, lead.id, lead.name ?? null, agora);
      if (f.consultaFutura || f.emAndamento) {
        resumo.seguradosPelaFranquia++;
        if (seco) registrarSimulacao(unit, ID_PERDA_IA, { leadId: lead.id, acao: 'pularia', alvo: ETAPA.PERDIDO, deEtapa: etapa, motivo: `franquia segura: ${f.emAndamento ? 'tratamento em andamento' : 'consulta futura'}` });
        continue;
      }

      if (!seco) {
        // a conversa levou segundos: relê o cartão e confere os portões de novo antes de escrever
        const fresco = await kommo.getLead(lead.id);
        if (porQueOCartaoFica(fresco, { agoraEpoch: Math.floor(Date.now() / 1000), tz, pausarIaFieldId: ctx.pausarIaFieldId })) continue;
        // ...e se o paciente respondeu nesse meio tempo, a frase que provava a recusa ficou velha
        const contato = (fresco._embedded?.contacts ?? []).find((c) => c.is_main)?.id ?? fresco._embedded?.contacts?.[0]?.id;
        if (contato !== undefined && linha.ultimaDoPacienteEm !== null && (await kommo.contatoEscreveuDesde(contato, linha.ultimaDoPacienteEm + 60))) {
          logger.info({ unit: unit.slug, leadId: lead.id }, 'perda-ia: o paciente escreveu enquanto a IA lia — não movi');
          continue;
        }
      }
      const etiqueta = !seco && !motivoTrabalhavel(decisao.motivo) ? await etiquetaDeNaoContatar(unit, kommo) : null;
      const d = decisaoDeFecho(decisao, etapa, etiqueta);
      const r = await fecharOuSegurar(unit, kommo, funis, lead.id, etapa, d, seco, ID_PERDA_IA, lead);
      if (seco ? r !== 'travado' : r === 'fechou') {
        resumo.moveria++;
        if (!seco) await pausa();
      }
    } catch (err) {
      resumo.erros++;
      if (erroPermanente(err)) marcarVisto(unit, ID_PERDA_IA, lead.id);
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'perda-ia: erro num cartão — pulei');
    }
  }
}

// ─── motivo-perdido-ia: o motivo de quem já está em PERDIDO ───────────────────────────────────────

/** Uma varredura do motivo-perdido-ia numa conta. Exportada para o teste. */
export async function varrerMotivos(ctx: { unit: Unit; kommo: KommoClient; funis: Funis; grupo?: GrupoDoCrm | null; seco: boolean; agora: number }, resumo: Resumo): Promise<void> {
  const { unit, kommo, funis, seco, agora } = ctx;
  const campo = await campoDoMotivo(unit, kommo);
  if (!campo) {
    logger.info({ unit: unit.slug }, `${ID_MOTIVO_PERDIDO_IA}: a conta não tem o campo «${CAMPO_MOTIVO_NAO_AGENDAMENTO}» — nada a fazer`);
    return;
  }
  const opcoes = campo.enums.map((e) => e.value);
  const entrados: KommoLead[] = [];
  for (let page = 1; page <= 4; page++) {
    const lote = await kommo.listLeadsDasEtapasDesde([{ pipelineId: funis.comercialId, statusId: PERDIDO }], agora - 25 * 3600, page);
    entrados.push(...lote);
    if (lote.length < 250) break;
  }
  const fila = entrados.filter(
    (l) => !jaVisto(unit, ID_MOTIVO_PERDIDO_IA, l.id) && !porQueNaoPreencherMotivo(l, { agoraEpoch: agora, comercialId: funis.comercialId }) && !pularCartao(ctx.grupo ?? null, unit.id, l, resumo),
  );
  resumo.candidatos = fila.length;

  let falhasDaIa = 0;
  for (const lead of fila) {
    if (resumo.avaliados >= MAX_MOTIVOS || falhasDaIa >= FALHAS_DA_IA_QUE_ENCERRAM) break;
    try {
      resumo.avaliados++; // conta a leitura, não só a IA: a cota é do Kommo
      const { falas } = await lerFalasDoCartao(kommo, lead.id);
      await transcreverAudios(unit, falas, MAX_AUDIOS);
      // o MESMO classificador do botão «Sugerir motivo»: prompt, lista de opções da conta e trava «perguntar não é recusar»
      const r = await perguntarAoModelo(unit, { user: montarPrompt(falas, opcoes), automacao: ID_MOTIVO_PERDIDO_IA });
      if (!r) {
        falhasDaIa++; // IA fora: tenta na próxima varredura
        continue;
      }
      falhasDaIa = 0;
      resumo.custoUsd += r.custoUsd;
      marcarVisto(unit, ID_MOTIVO_PERDIDO_IA, lead.id);
      const sug = interpretarResposta(r.texto, falas, opcoes);
      if (!sug) {
        logger.info({ unit: unit.slug, leadId: lead.id }, `${ID_MOTIVO_PERDIDO_IA}: sem opção adequada na lista da conta — não gravei nada`);
        if (seco) registrarSimulacao(unit, ID_MOTIVO_PERDIDO_IA, { leadId: lead.id, acao: 'pularia', alvo: CAMPO_MOTIVO_NAO_AGENDAMENTO, motivo: 'a IA não achou opção adequada na lista da conta' });
        continue;
      }
      const opcao = campo.enums.find((e) => e.value === sug.motivo);
      if (!opcao) continue;
      if (seco) {
        resumo.gravados++;
        logger.info({ unit: unit.slug, leadId: lead.id, motivo: opcao.value, travado: sug.travado }, `${ID_MOTIVO_PERDIDO_IA} [seco]: gravaria`);
        registrarSimulacao(unit, ID_MOTIVO_PERDIDO_IA, { leadId: lead.id, acao: 'gravaria', alvo: CAMPO_MOTIVO_NAO_AGENDAMENTO, valor: opcao.value, motivo: sug.frase ? `paciente: «${sug.frase.slice(0, 120)}»` : 'sem frase do paciente (sumiço)' });
        continue;
      }
      // nunca sobrescreve: relê o cartão (a SDR pode ter escolhido enquanto a IA lia)
      const fresco = await kommo.getLead(lead.id);
      if (porQueNaoPreencherMotivo({ ...fresco, closed_at: lead.closed_at ?? fresco.closed_at }, { agoraEpoch: Math.floor(Date.now() / 1000), comercialId: funis.comercialId })) continue;
      await kommo.setLeadCustomFieldValue(lead.id, campo.id, 'select', opcao.value, campo.enums);
      await kommo
        .addLeadNote(lead.id, `A IA leu a conversa e preencheu o ⊘ Motivo do não agendamento: «${opcao.value}»${sug.frase ? ` (paciente: «${sug.frase.slice(0, 120)}»)` : ''}. Troque se estiver errado.`)
        .catch(() => null);
      resumo.gravados++;
      logger.info({ unit: unit.slug, leadId: lead.id, motivo: opcao.value }, `${ID_MOTIVO_PERDIDO_IA}: motivo gravado`);
      await pausa();
    } catch (err) {
      resumo.erros++;
      if (erroPermanente(err)) marcarVisto(unit, ID_MOTIVO_PERDIDO_IA, lead.id);
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, `${ID_MOTIVO_PERDIDO_IA}: erro num cartão — pulei`);
    }
  }
}

// ─── a varredura ──────────────────────────────────────────────────────────────────────────────────

let rodando = false;

async function varrerUnidade(unit: Unit, todas: Unit[], dividida?: { kommoDe: Unit; grupo: GrupoDoCrm }): Promise<void> {
  const ePerda = estadoPerda(unit.slug);
  const eMotivo = estadoMotivo(unit.slug);
  if (ePerda === 'desligado' && eMotivo === 'desligado') return;
  const kommo = createKommoClient(dividida?.kommoDe ?? unit);
  const funis = await funisDaConta(dividida?.kommoDe ?? unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'perda-ia: não achei o funil COMERCIAL — pulei a conta');
    return;
  }
  const agora = Math.floor(Date.now() / 1000);

  if (ePerda !== 'desligado') {
    const resumo = resumoNovo(unit, ID_PERDA_IA, ePerda === 'seco');
    try {
      const campo = await campoDoMotivo(dividida?.kommoDe ?? unit, kommo);
      if (!campo) logger.info({ unit: unit.slug }, `${ID_PERDA_IA}: a conta não tem o campo «${CAMPO_MOTIVO_NAO_AGENDAMENTO}» com opções — sem motivo para dar, não move ninguém`);
      else await varrerPerda({ unit, kommo, funis, grupo: dividida?.grupo ?? null, unidadesDaConta: todas, pausarIaFieldId: (dividida?.kommoDe ?? unit).kommoPausedFieldId ?? unit.kommoPausedFieldId ?? null, seco: resumo.seco, agora, opcoes: campo.enums.map((e) => e.value) }, resumo);
    } finally {
      logger.info(resumo, `${ID_PERDA_IA}: varredura`);
    }
  }
  if (eMotivo !== 'desligado') {
    const resumo = resumoNovo(unit, ID_MOTIVO_PERDIDO_IA, eMotivo === 'seco');
    try {
      await varrerMotivos({ unit, kommo, funis, grupo: dividida?.grupo ?? null, seco: resumo.seco, agora }, resumo);
    } finally {
      logger.info(resumo, `${ID_MOTIVO_PERDIDO_IA}: varredura`);
    }
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    // Uma conta Kommo por vez; na conta dividida (Petrópolis + Caxias) cada unidade varre os seus cartões com a SUA chave.
    const porConta = new Map<string, { dona: Unit; todas: Unit[] }>();
    for (const u of units) {
      const conta = u.kommoSubdomain?.trim().toLowerCase();
      if (!conta) continue;
      const g = porConta.get(conta) ?? { dona: u, todas: [] };
      g.todas.push(u);
      const ligada = (x: Unit) => estadoPerda(x.slug) !== 'desligado' || estadoMotivo(x.slug) !== 'desligado';
      if (!ligada(g.dona) && ligada(u)) g.dona = u;
      porConta.set(conta, g);
    }
    for (const { dona, todas } of porConta.values()) {
      const dividida = await contaDividida(todas);
      if (dividida) {
        if (!dividida.conta.kommoAccessToken) continue;
        for (const m of dividida.membros) {
          await varrerUnidade(m, todas, { kommoDe: dividida.conta, grupo: dividida.grupo }).catch((err) => logger.warn({ err: String(err), unit: m.slug }, 'perda-ia: conta falhou'));
        }
        continue;
      }
      if (!dona.kommoAccessToken) continue;
      await varrerUnidade(dona, todas).catch((err) => logger.warn({ err: String(err), unit: dona.slug }, 'perda-ia: conta falhou'));
    }
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startPerdaIaWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info({ sweepMs: SWEEP_MS, horas: HORAS_SEM_PACIENTE, maxAvaliacoes: MAX_AVALIACOES, maxMovimentos: MAX_MOVIMENTOS }, 'perda-ia worker iniciado');
}

export function stopPerdaIaWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
