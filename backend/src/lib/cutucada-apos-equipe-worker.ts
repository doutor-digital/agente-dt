/**
 * O worker da CUTUCADA DEPOIS DA EQUIPE (regras e quem-é-quem em `cutucada-apos-equipe.ts`).
 *
 * A cada poucos minutos, por unidade com a chave em «só no papel» ou ligada: acha os cartões abertos da entrada e de EM QUALIFICAÇÃO
 * que mexeram nas últimas horas, lê a conversa oficial do Kommo (a fala da SDR pelo celular só existe lá), e quando a ÚLTIMA fala é
 * da equipe e o paciente ficou 2 h sem responder, a Sofia escreve UMA mensagem curta e manda — uma vez por lead, só em horário
 * comercial.
 *
 * ORDEM DAS CONFERÊNCIAS (do barato ao caro; nada disto gasta o Kommo ou o modelo à toa):
 *   unidade em pausa / fora do horário → cartão (etapa, etiquetas, Pausar IA, ◷ Retomar em, consulta futura) → banco (já cutucado,
 *   pausa com data) → conversa oficial (quem falou por último, prazo) → número interno, franquia (consulta futura, paciente em
 *   tratamento), teto de cobranças do dia → o texto (modelo + as travas da régua + as regras do pedido) → SÓ ENTÃO, se ligado:
 *   relê cartão e conversa, marca, envia, grava.
 *
 * SECO NÃO ESCREVE NADA no Kommo nem no paciente: decide, gera o texto e registra («mandaria» com o TEXTO, «pularia» com o motivo)
 * na tela de Automações. O modelo RODA (centavos): o João precisa ver o texto antes de ligar.
 *
 * UMA VEZ POR LEAD: a marca é uma linha em `execution_traces` com o id `cutucada-apos-equipe-<unit_id>-<lead_id>`, gravada ANTES do envio. O id é
 * chave primária: a segunda gravação falha, então duas réplicas, dois deploys ou duas varreduras seguidas não mandam duas.
 *
 * NÃO MEXE na régua: o `follow-up-24h` continua cobrando só quando a ÚLTIMA mensagem do nosso banco é da Sofia e para quando a
 * equipe fala. A cutucada só olha o caso que ele não enxerga (a fala da equipe pelo celular nunca está no nosso banco).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, isLeadPaused, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { historicoOficial } from '../services/kommo-talks-normalizar.js';
import { enviosDaSofia } from '../services/kommo-talks.service.js';
import { estadoDaAutomacao, recarregarAutomacoes, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { pularCartao, grupoDaUnidade, type GrupoDoCrm } from './crm-compartilhado.js';
import { funisDaConta, conta } from './rotina-nucleo.js';
import type { Funis } from './franquia-sync-worker.js';
import { franquiaDoPaciente } from './parados-worker.js';
import { ehNumeroInterno } from './numeros-internos.js';
import { consultarFranquia, decidir } from './paciente-em-tratamento.js';
import { agendarIndice, chaveDoTelefone, consultarIndice } from './franquia-indice-telefones.js';
import { contatoPrincipal } from './kommo-lead-util.js';
import { enviosDeRetomadaRecentes, limiteDoDiaAtingido } from './cobrancas-do-dia.js';
import { fusoDaUnidade } from './fuso.js';
import {
  ID_CUTUCADA,
  META_DA_CUTUCADA,
  cartaoComEtiquetaDeRobo,
  clinicaAtendendoAgora,
  configDaCutucada,
  decidirPelaConversa,
  etapaDaCutucada,
  trechoSemTelefone,
  idDaMarcaDaCutucada,
  porQueOCartaoFicaQuieto,
  reclassificarFalas,
  type ConfigDaCutucada,
  type Fala,
  type PorQuePular,
} from './cutucada-apos-equipe.js';
import type { ResultadoDoTexto } from '../agent/cutucada.js';

const SWEEP_MS = Number(process.env.CUTUCADA_SWEEP_MS) || 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 3 * 60_000;
const MAX_PAGINAS = 8;
/** Cartões cuja conversa é LIDA no Kommo por unidade por varredura (1 + N chamadas cada): o limitador do Kommo é da rede inteira. */
export const MAX_LEITURAS = Number(process.env.CUTUCADA_MAX_LEITURAS) || 30;
/** Textos gerados (modelo) por unidade por varredura. */
export const MAX_TEXTOS = Number(process.env.CUTUCADA_MAX_TEXTOS) || 8;
/** Mensagens que podem SAIR por unidade por varredura: a clínica não recebe 40 respostas de uma vez ao ligar. */
export const MAX_ENVIOS = Number(process.env.CUTUCADA_MAX_ENVIOS) || 4;
/** Tentativas de texto por fala da equipe: se o modelo/as travas reprovam duas vezes, esta cutucada não sai (não gasta modelo de 5 em 5 min). */
const TENTATIVAS_DE_TEXTO = 2;
const PAUSA_ENTRE_ENVIOS_MS = 1500;
const SEGURADA_MS = 30 * 60_000;
/** Conta sem o escopo de conversas (403 sempre): não adianta tentar de novo a cada varredura. */
const ERRO_PERMANENTE = /\b403\b|Invalid scope/i;
const ESPERA_DO_ERRO_PERMANENTE_MS = 6 * 3_600_000;
const ERROS_PERMANENTES_QUE_ENCERRAM = 3;
const ESPERA_DO_ERRO_MS = 10 * 60_000;

export const estadoDaCutucada = (slug: string, raw: string | undefined = process.env.CUTUCADA_APOS_EQUIPE_SLUGS): Estado => estadoDaAutomacao(slug, ID_CUTUCADA, raw);

// ─── contador da varredura (vai inteiro para o log: é a medição do teste) ─────────────────────────

export interface ResumoDaCutucada {
  unit: string;
  seco: boolean;
  /** cartões abertos nas etapas da cutucada que mexeram na janela */
  candidatos: number;
  /** barrados só pelo cartão/banco/cache, por motivo */
  barrados: Record<string, number>;
  /** conversas lidas no Kommo */
  lidas: number;
  /** a conversa pediu cutucar, mas outra trava segurou, por motivo (também vai à tela como «pularia») */
  seguradas: Record<string, number>;
  /** pelo prazo/quem falou por último: não é caso (por motivo) */
  naoEhCaso: Record<string, number>;
  textosGerados: number;
  textosReprovados: number;
  /** «só no papel»: mandaria */
  mandaria: number;
  /** ligado: mensagens enviadas */
  enviadas: number;
  erros: number;
  /** a janela de cartões bateu no teto de páginas */
  truncado?: boolean;
  deOutraUnidade?: number;
  semUnidade?: number;
}

const resumoNovo = (unit: Unit, seco: boolean): ResumoDaCutucada => ({
  unit: unit.slug, seco, candidatos: 0, barrados: {}, lidas: 0, seguradas: {}, naoEhCaso: {}, textosGerados: 0, textosReprovados: 0, mandaria: 0, enviadas: 0, erros: 0,
});

// ─── o que o worker precisa do mundo (trocável no teste) ──────────────────────────────────────────

export type KommoDaCutucada = Pick<KommoClient, 'listLeadsDasEtapasDesde' | 'getLead' | 'listTalks' | 'listTalkMessages' | 'getContactPhone' | 'sendChatReply'>;

export interface DepsDaCutucada {
  agora: () => Date;
  kommo: KommoDaCutucada;
  funis: Funis;
  grupo: GrupoDoCrm | null;
  /** os ids dos cartões que já receberam a cutucada (a marca persistente) */
  jaCutucados: (unitId: string, leadIds: number[]) => Promise<Set<number>>;
  /** grava a marca ANTES do envio. `ja_existia` = outra varredura/réplica chegou primeiro */
  gravarMarca: (unit: Unit, leadId: number, dados: Record<string, unknown>) => Promise<'criada' | 'ja_existia' | 'erro'>;
  enviosDaSofia: (unit: Unit, leadId: number, desde: Date) => Promise<Date[]>;
  leadPausadoPorJanela: (unitId: string, leadId: number) => Promise<boolean>;
  caixinhaMarcada: (unit: Unit, leadId: number) => Promise<boolean>;
  unidadeEmPausaAgora: (unit: Unit) => Promise<boolean>;
  /** A chave desta unidade está LIGADA agora? Relê do banco (desligar na tela tem de valer na hora, não em 30 s). */
  chaveLigadaAgora: (unit: Unit) => Promise<boolean>;
  /** devolve o motivo para NÃO cutucar (franquia, número interno), ou null */
  porQueAFranquiaSegura: (unit: Unit, kommo: KommoDaCutucada, lead: KommoLead) => Promise<string | null>;
  tetoDoDiaAtingido: (unit: Unit, leadId: number, agora: Date) => Promise<boolean>;
  escrever: (a: { unit: Unit; leadId: number; falas: readonly Fala[]; tituloDoCartao: string | null; contato: string | null }) => Promise<ResultadoDoTexto>;
  gravarMensagem: (unit: Unit, leadId: number, texto: string, contato: string | null, meta: Record<string, unknown>) => Promise<void>;
  esperar: (ms: number) => Promise<void>;
}

// ─── as leituras reais ────────────────────────────────────────────────────────────────────────────

async function jaCutucadosNoBanco(unitId: string, leadIds: number[]): Promise<Set<number>> {
  if (!leadIds.length) return new Set();
  const linhas = await prisma.executionTrace.findMany({
    where: { id: { in: leadIds.map((l) => idDaMarcaDaCutucada(unitId, l)) } },
    select: { leadId: true },
  });
  return new Set(linhas.map((l) => Number(l.leadId)));
}

async function gravarMarcaNoBanco(unit: Unit, leadId: number, dados: Record<string, unknown>): Promise<'criada' | 'ja_existia' | 'erro'> {
  const id = idDaMarcaDaCutucada(unit.id, leadId);
  try {
    await prisma.executionTrace.create({
      data: {
        id,
        unitId: unit.id,
        leadId: String(leadId),
        threadId: id,
        input: { origem: ID_CUTUCADA },
        channel: 'manual',
        status: 'SUCCESS',
        steps: { create: { sequence: 0, kind: 'KOMMO_ACTION', title: `CUTUCADA · depois da equipe, ${unit.slug}`, payload: dados as object } },
      },
    });
    return 'criada';
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return 'ja_existia';
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'cutucada: não gravei a marca — nada sai');
    return 'erro';
  }
}

/** O que a conferência da franquia precisa do mundo (trocável no teste). */
export interface DepsDaFranquia {
  indice: (unitId: string, chave: string) => Promise<{ fresco: boolean; idadeHoras: number | null }>;
  franquiaDoPaciente: typeof franquiaDoPaciente;
  consultarFranquia: typeof consultarFranquia;
  agendarIndice: (unit: Unit) => void;
}
const depsDaFranquia: DepsDaFranquia = { indice: consultarIndice, franquiaDoPaciente, consultarFranquia, agendarIndice };

/**
 * Número interno e franquia — a mesma pergunta da porta `calar-paciente-em-tratamento`, feita ANTES de falar (e não depois de a
 * mensagem chegar): número interno, consulta futura ou tratamento em andamento na franquia (pelo vínculo ou pelo nome do cartão),
 * e paciente da franquia com tratamento ativo ou sessão futura pelo TELEFONE (o cartão novo e vazio do Lite: «Lead 23 14/11/2026»).
 *
 * NA DÚVIDA, NÃO MANDA — e dúvida inclui o índice de telefones: `consultarFranquia` devolve «não achou» com o índice velho ou vazio, e
 * «não achou» ali NÃO autoriza afirmar que o telefone não é de paciente (a classe do incidente de 14/11). Só com o índice fresco
 * (carga inteira com menos de 36 h) o «não achou» vale. Unidade sem franquia conectada não tem o que perguntar.
 */
export async function porQueAFranquiaSeguraComDeps(unit: Unit, kommo: KommoDaCutucada, lead: KommoLead, deps: DepsDaFranquia = depsDaFranquia): Promise<string | null> {
  const idContato = contatoPrincipal(lead);
  const telefone = idContato ? await kommo.getContactPhone(idContato).catch(() => null) : null;
  if (!telefone) return 'não consegui o telefone do contato (cartão sem telefone, ou o Kommo não respondeu)';
  if (ehNumeroInterno(telefone)) return 'número interno da rede (NUMEROS_INTERNOS)';
  if (!unit.spineEnabled || !unit.spineToken) return null;

  try {
    const f = await deps.franquiaDoPaciente(unit, lead.id, lead.name ?? null, Math.floor(Date.now() / 1000));
    if (f.emAndamento) return 'tratamento em andamento na franquia';
    if (f.consultaFutura) return 'consulta futura na franquia';
  } catch (err) {
    return `a franquia não respondeu (${String(err).slice(0, 80)}): na dúvida, não cutuca`;
  }
  deps.agendarIndice(unit); // pede a carga se for hora (em segundo plano); o índice que vale é o que já está pronto
  const chave = chaveDoTelefone(telefone);
  if (!chave) return 'franquia sem índice fresco: telefone ilegível para conferir';
  const ind = await deps.indice(unit.id, chave).catch(() => null);
  if (!ind) return 'franquia sem índice fresco: não consegui ler o índice de telefones';
  if (!ind.fresco) return `franquia sem índice fresco (${ind.idadeHoras === null ? 'nunca carregado' : `${ind.idadeHoras} h`}): não dá para afirmar que o telefone não é de paciente`;
  const sinal = await deps.consultarFranquia(unit, telefone);
  if (sinal.tipo === 'indisponivel') return `a franquia não respondeu pelo telefone (${sinal.motivo.slice(0, 80)}): na dúvida, não cutuca`;
  const d = decidir({ interno: false, temIdClient: false, funil: 'COMERCIAL', sinal });
  return d.calar ? `paciente em tratamento na franquia: ${d.detalhe}` : null;
}

async function gravarMensagemNoBanco(unit: Unit, leadId: number, texto: string, contato: string | null, meta: Record<string, unknown>): Promise<void> {
  let conversa = await prisma.conversation.findFirst({ where: { unitId: unit.id, leadId: String(leadId) }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } });
  if (!conversa) {
    conversa = await prisma.conversation.create({ data: { unitId: unit.id, leadId: String(leadId), channel: 'kommo', contactName: contato }, select: { id: true } });
  }
  await prisma.message.create({ data: { conversationId: conversa.id, role: 'assistant', content: texto, meta: meta as object } });

}

export async function depsReais(unit: Unit): Promise<DepsDaCutucada | null> {
  let kommo: KommoClient;
  try {
    kommo = createKommoClient(unit);
  } catch {
    return null;
  }
  const funis = await funisDaConta(unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'cutucada: não achei o funil COMERCIAL — pulei a unidade');
    return null;
  }
  const { escreverCutucada } = await import('../agent/cutucada.js');
  return {
    agora: () => new Date(),
    kommo,
    funis,
    grupo: await grupoDaUnidade(unit.id),
    jaCutucados: jaCutucadosNoBanco,
    gravarMarca: gravarMarcaNoBanco,
    // a saída «Salesbot» do Kommo precisa casar com os envios nossos, a cutucada inclusive (a pausa pela equipe, ao contrário, NÃO a vê)
    enviosDaSofia: (u, leadId, desde) => enviosDaSofia(u, leadId, desde, { comCutucada: true }),
    leadPausadoPorJanela,
    caixinhaMarcada: (u, leadId) => isLeadPaused(u, leadId),
    unidadeEmPausaAgora: async (u) => {
      const fresca = await prisma.unit.findUnique({ where: { id: u.id }, select: { pausaDesde: true, pausaAte: true } });
      return !!fresca && emPausa(fresca);
    },
    chaveLigadaAgora: async (u) => {
      await recarregarAutomacoes();
      return estadoDaCutucada(u.slug) === 'ligado';
    },
    porQueAFranquiaSegura: (u, k, l) => porQueAFranquiaSeguraComDeps(u, k, l),
    tetoDoDiaAtingido: async (u, leadId, agora) => limiteDoDiaAtingido(await enviosDeRetomadaRecentes(u, String(leadId), agora), agora, fusoDaUnidade(u)),
    escrever: escreverCutucada,
    gravarMensagem: gravarMensagemNoBanco,
    esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ─── pequenas peças ───────────────────────────────────────────────────────────────────────────────

/** `unit:lead` → o que já se sabe da conversa deste cartão enquanto ele não mexer (e, no «dentro do prazo», até quando). */
const vistoAte = new Map<string, { atualizadoEm: number; ateMs: number | null }>();
/** `unit:lead:idDaFala` → quantas vezes o texto foi reprovado / já foi simulado. */
const tentativas = new Map<string, number>();
const simulados = new Set<string>();

export function _limparMemoriaDaCutucada(): void {
  vistoAte.clear();
  tentativas.clear();
  simulados.clear();
}

function podaMapa(m: Map<string, unknown> | Set<string>): void {
  if (m.size <= 20_000) return;
  const chaves = [...m.keys()];
  for (const k of chaves.slice(0, 10_000)) m.delete(k);
}

/** As etapas do COMERCIAL onde a SDR faz a 1ª abordagem: a entrada (qualquer nome) e EM QUALIFICAÇÃO, pelos ids da conta. */
export function etapasDaCutucada(funis: Funis): Array<{ pipelineId: number; statusId: number }> {
  const out: Array<{ pipelineId: number; statusId: number }> = [];
  for (const [chave, s] of funis.status) {
    if (chave.startsWith('COMERCIAL:') && etapaDaCutucada(s.nome)) out.push({ pipelineId: funis.comercialId, statusId: s.id });
  }
  return out;
}

/**
 * Os cartões DESSAS etapas que mexeram desde `desde` (epoch s) — o filtro vai na consulta, então a janela não se enche de cartão de
 * outro funil. Mensagem da equipe no Kommo mexe no cartão (medido em Petrópolis: 66 de 68 cartões com fala da equipe tinham `updated_at`
 * igual ou depois dela); o que escapar fica sem cutucada, nunca com uma a mais. Erro do Kommo lança: página vazia quer dizer «acabou».
 *
 * O Kommo devolve do MAIS ANTIGO ao mais novo (250 por vez): anda-se pela data do último cartão lido, sem repetir. `truncado` = bateu no teto
 * de leituras e o que ficou de fora são os MAIS NOVOS — o contrário do que se quer, por isso vai no log e no resumo, nunca em silêncio.
 */
export async function cartoesDaJanela(kommo: KommoDaCutucada, etapas: Array<{ pipelineId: number; statusId: number }>, desde: number): Promise<{ cartoes: KommoLead[]; truncado: boolean }> {
  const vistos = new Map<number, KommoLead>();
  if (!etapas.length) return { cartoes: [], truncado: false };
  let de = desde;
  for (let leitura = 1; leitura <= MAX_PAGINAS; leitura++) {
    const lote = await kommo.listLeadsDasEtapasDesde(etapas, de, 1);
    const antes = vistos.size;
    for (const l of lote) vistos.set(l.id, l);
    if (lote.length < 250) return { cartoes: [...vistos.values()], truncado: false };
    const ultimo = Math.max(...lote.map((l) => l.updated_at ?? 0));
    if (vistos.size === antes || ultimo <= de) break; // 250 cartões no mesmo segundo: não anda; para em vez de repetir para sempre
    de = ultimo;
  }
  return { cartoes: [...vistos.values()], truncado: true };
}

const MOTIVO_DA_CONVERSA: Record<PorQuePular, string> = {
  sem_conversa: 'sem conversa no Kommo',
  paciente_falou_por_ultimo: 'o paciente falou por último',
  sofia_falou_por_ultimo: 'a Sofia falou por último',
  robo_falou_por_ultimo: 'um robô ou a resposta automática do app falou por último',
  dentro_do_prazo: 'a equipe falou há menos que o prazo',
  fala_muito_antiga: 'a fala da equipe é mais velha que o limite',
  fala_de_encerramento: 'a equipe se despediu/confirmou (não deixou pergunta no ar)',
  clinica_deve_retorno: 'a equipe prometeu retorno: quem deve a resposta é a clínica',
};

/** Só vira «pularia» na tela o que era para cutucar e foi SEGURADO por uma trava — o resto (paciente falou, prazo) é ruído. */
function pularia(unit: Unit, leadId: number, motivo: string): void {
  registrarSimulacao(unit, ID_CUTUCADA, { leadId, acao: 'pularia', alvo: 'mensagem-segurada', motivo }); // alvo próprio: um «pularia» não apaga o texto do «mandaria»
}

// ─── a varredura de uma unidade ───────────────────────────────────────────────────────────────────

export async function varrerCutucada(unit: Unit, estado: Exclude<Estado, 'desligado'>, deps: DepsDaCutucada): Promise<ResumoDaCutucada> {
  const seco = estado === 'seco';
  const r = resumoNovo(unit, seco);
  const agora = deps.agora();
  const agoraS = Math.floor(agora.getTime() / 1000);
  const tz = fusoDaUnidade(unit);
  const cfg: ConfigDaCutucada = configDaCutucada(unit.pipelineIntents);

  // 1) a unidade inteira: pausa da recepção e o horário REAL de atendimento (cada dia com o seu horário — `spine_day_hours` —, fuso, feriado, 8h–20h no máximo)
  if (emPausa(unit, agora)) {
    conta(r.barrados, 'unidade-em-pausa');
    return r;
  }
  if (!clinicaAtendendoAgora(unit, agora)) {
    conta(r.barrados, 'fora-do-horario');
    return r;
  }

  // Ligado precisa de ROTA DE ENVIO pelo Salesbot (o mesmo caminho da Sofia): sem ela o `sendChatReply` cairia numa NOTA no cartão e o
  // paciente não receberia nada. No papel segue — o João precisa ver os textos mesmo antes de a rota existir.
  // E sem o modo «bypass»: ali o texto vai em pedaços de 240 caracteres e, se o 2º falha, o cliente tenta OUTRAS rotas e o paciente pode receber duas vezes.
  if (!seco && !(unit.kommoReplyFieldId && unit.kommoSalesbotId && !unit.kommoBypassSalesbot)) {
    conta(r.barrados, 'sem-rota-de-envio-pelo-salesbot');
    logger.warn({ unit: unit.slug }, 'cutucada: a unidade não tem Salesbot + campo de resposta (ou usa o modo bypass, que envia em pedaços) — ligada não enviaria com segurança, pulei');
    return r;
  }

  // O `follow-up-24h` (a régua) decide pela última mensagem do NOSSO banco: a cutucada gravada como da Sofia reabriria a escada numa conversa que
  // ela ignorava, e as duas mandariam toque ao mesmo lead. Por isso, ligada, a cutucada só roda onde a régua está desligada (Petrópolis). No papel segue.
  if (!seco && unit.followUpEnabled) {
    conta(r.barrados, 'follow-up-ligado-na-unidade');
    logger.warn({ unit: unit.slug }, 'cutucada: a régua (follow-up) está ligada nesta unidade — as duas mexeriam na mesma conversa; desligue uma das duas. Pulei');
    return r;
  }

  // 2) o cartão (de graça): etapa, etiquetas, Pausar IA, ◷ Retomar em, consulta futura no cartão
  const { cartoes, truncado } = await cartoesDaJanela(deps.kommo, etapasDaCutucada(deps.funis), agoraS - (cfg.idadeMaxH + 4) * 3600);
  if (truncado) {
    r.truncado = true;
    logger.warn({ unit: unit.slug, lidos: cartoes.length }, 'cutucada: a janela tem mais cartões que o teto de leituras — os MAIS NOVOS ficaram de fora desta varredura (aumente a frequência ou encurte cutucada_idade_max_h)');
  }
  const noFunil: KommoLead[] = [];
  for (const lead of cartoes) {
    const etapa = deps.funis.nomeDe(lead.pipeline_id, lead.status_id);
    if (!etapa || etapa.funil !== 'COMERCIAL' || !etapaDaCutucada(etapa.status)) continue;
    noFunil.push(lead);
  }
  r.candidatos = noFunil.length;
  const abertos: KommoLead[] = [];
  for (const lead of noFunil) {
    if (pularCartao(deps.grupo, unit.id, lead, r)) continue; // Kommo dividido: só os cartões desta unidade
    const visto = vistoAte.get(`${unit.id}:${seco ? 'seco' : 'ligado'}:${lead.id}`);
    if (visto && visto.atualizadoEm === (lead.updated_at ?? 0) && (visto.ateMs === null || agora.getTime() < visto.ateMs)) {
      conta(r.barrados, 'conversa-ja-lida-sem-novidade');
      continue;
    }
    const razao = porQueOCartaoFicaQuieto(lead, { agora: agoraS, tz, pausarIaFieldId: unit.kommoPausedFieldId ?? null });
    if (razao) {
      conta(r.barrados, razao.codigo);
      continue;
    }
    abertos.push(lead);
  }

  // 3) o banco: já cutucado (a marca). Em lote, uma leitura só.
  const cutucados = await deps.jaCutucados(unit.id, abertos.map((l) => l.id));
  const fila: KommoLead[] = [];
  for (const lead of abertos) {
    if (cutucados.has(lead.id)) {
      conta(r.barrados, 'ja-cutucado');
      continue;
    }
    fila.push(lead);
  }
  fila.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  // 4) a conversa e o que vem depois, no teto
  let textos = 0;
  let errosPermanentes = 0;
  for (const lead of fila) {
    if (r.lidas >= MAX_LEITURAS || textos >= MAX_TEXTOS || r.enviadas >= MAX_ENVIOS) break;
    // a memória é POR ESTADO: o que o «só no papel» já viu não pode esconder o lead quando a chave passa a ligada (o João liga sem reiniciar o processo)
    const chaveVisto = `${unit.id}:${seco ? 'seco' : 'ligado'}:${lead.id}`;
    try {
      r.lidas++;
      const falas = await lerFalas(unit, deps, lead);
      errosPermanentes = 0; // «três SEGUIDOS»: uma leitura boa zera a conta
      const d = decidirPelaConversa(falas, agora, cfg);
      if (d.tipo === 'pular') {
        conta(r.naoEhCaso, d.porque);
        if (d.porque === 'clinica_deve_retorno') pularia(unit, lead.id, 'clínica deve retorno: a equipe prometeu voltar com a resposta, quem deve é a clínica');
        podaMapa(vistoAte);
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: d.porque === 'dentro_do_prazo' ? (d.depoisDe ?? null) : null });
        continue;
      }
      const ultima = d.ultimaDaEquipe;
      // pausa com data do widget: uma consulta por candidato REAL (não uma por cartão da janela)
      if (await deps.leadPausadoPorJanela(unit.id, lead.id).catch(() => true)) {
        conta(r.barrados, 'pausa-com-data');
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + SEGURADA_MS });
        continue;
      }
      const chaveFala = `${unit.id}:${lead.id}:${ultima.id}`;
      // texto já reprovado duas vezes para esta fala da equipe: nem pergunta à franquia nem gasta o modelo (só uma fala nova muda isso)
      if ((tentativas.get(chaveFala) ?? 0) >= TENTATIVAS_DE_TEXTO) {
        conta(r.barrados, 'texto-reprovado-duas-vezes');
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: null });
        continue;
      }

      // 5) as travas que olham fora do cartão (franquia, número interno, teto do dia): se seguram, é «pularia»
      const fresco = await deps.kommo.getLead(lead.id);
      const motivo = (await deps.porQueAFranquiaSegura(unit, deps.kommo, fresco)) ?? ((await deps.tetoDoDiaAtingido(unit, lead.id, agora)) ? 'já saíram as cobranças do dia (teto de 2)' : null);
      if (motivo) {
        conta(r.seguradas, motivo.split(':')[0].slice(0, 60));
        pularia(unit, lead.id, motivo);
        // franquia/teto mudam devagar: não relê a conversa nem pergunta à franquia de novo por 30 min (se o cartão mexer, relê na hora)
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + SEGURADA_MS });
        continue;
      }

      // 6) o texto. O «nome de perfil» do WhatsApp (o que o paciente escolheu para si) vem da última fala dele: a trava da régua
      // que tira «Oi, Tricolor!» precisa dele.
      if (seco && simulados.has(chaveFala)) {
        conta(r.barrados, 'ja-simulada');
        continue;
      }
      textos++;
      const contato = [...falas].reverse().find((f) => f.autor === 'paciente' && f.autorNome.trim())?.autorNome.trim() ?? null;
      const t = await deps.escrever({ unit, leadId: lead.id, falas, tituloDoCartao: fresco.name ?? null, contato });
      if (t.texto === null) {
        r.textosReprovados++;
        // modelo fora do ar / conta no teto do mês não é «texto reprovado»: não gasta uma das duas tentativas
        if (!t.transitorio) {
          podaMapa(tentativas);
          tentativas.set(chaveFala, (tentativas.get(chaveFala) ?? 0) + 1);
        }
        conta(r.seguradas, 'texto-nao-saiu');
        pularia(unit, lead.id, `o texto não saiu: ${t.porque}`);
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + SEGURADA_MS }); // uma 2ª tentativa só daqui a 30 min
        continue;
      }
      r.textosGerados++;

      if (seco) {
        r.mandaria++;
        podaMapa(simulados);
        simulados.add(chaveFala);
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: null }); // já simulada: só relê se o cartão mexer
        registrarSimulacao(unit, ID_CUTUCADA, {
          leadId: lead.id,
          acao: 'mandaria',
          alvo: 'mensagem',
          valor: t.texto,
          deEtapa: deps.funis.nomeDe(lead.pipeline_id, lead.status_id)?.status ?? null,
          motivo: `a equipe falou por último em ${ultima.em.toISOString()} (${ultima.autorNome || 'equipe'}): «${trechoSemTelefone(ultima.texto || (ultima.anexo ? `[${ultima.anexo}]` : ''))}» — o paciente não respondeu`,
        });
        logger.info({ unit: unit.slug, leadId: lead.id, texto: t.texto }, 'cutucada [seco]: mandaria');
        continue;
      }

      // 7) ligado: relê tudo (a conversa levou segundos), marca, envia, grava
      const resultado = await enviar(unit, deps, lead, ultima, t.texto, contato, cfg, agora, tz);
      if (resultado.tipo === 'segurou') {
        conta(r.seguradas, resultado.motivo);
        pularia(unit, lead.id, resultado.motivo);
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + SEGURADA_MS });
        if (/chave foi desligada|clínica fechou/.test(resultado.motivo)) break; // nenhum dos envios que faltam pode sair
        continue;
      }
      if (resultado.tipo === 'erro') {
        r.erros++;
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + SEGURADA_MS });
        continue;
      }
      r.enviadas++;
      await deps.esperar(PAUSA_ENTRE_ENVIOS_MS);
    } catch (err) {
      r.erros++;
      if (ERRO_PERMANENTE.test(String(err))) {
        // 403 de escopo (conta sem /talks): vale esperar horas, e três seguidos encerram a varredura da unidade
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + ESPERA_DO_ERRO_PERMANENTE_MS });
        if (++errosPermanentes >= ERROS_PERMANENTES_QUE_ENCERRAM) {
          logger.warn({ unit: unit.slug }, 'cutucada: o Kommo recusou a leitura das conversas (403) várias vezes seguidas — encerrei a varredura desta unidade');
          break;
        }
      } else {
        vistoAte.set(chaveVisto, { atualizadoEm: lead.updated_at ?? 0, ateMs: agora.getTime() + ESPERA_DO_ERRO_MS }); // sem recuo, o mesmo cartão com defeito comeria vaga de leitura a cada 5 min
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'cutucada: erro num cartão — pulei');
      }
    }
  }
  return r;
}

async function lerFalas(unit: Unit, deps: DepsDaCutucada, lead: KommoLead): Promise<Fala[]> {
  const { mensagens } = await historicoOficial(deps.kommo, lead.id, 40);
  const primeira = mensagens[0];
  const envios = primeira ? await deps.enviosDaSofia(unit, lead.id, new Date(primeira.em.getTime() - 10 * 60_000)) : [];
  return reclassificarFalas(mensagens, envios, { cartaoComEtiquetaDeRobo: cartaoComEtiquetaDeRobo(lead) });
}

type ResultadoDoEnvio = { tipo: 'enviou' } | { tipo: 'segurou'; motivo: string } | { tipo: 'erro' };

async function enviar(unit: Unit, deps: DepsDaCutucada, lead: KommoLead, ultima: Fala, texto: string, contato: string | null, cfg: ConfigDaCutucada, agora: Date, tz: string): Promise<ResultadoDoEnvio> {
  const agoraNovo = deps.agora();
  const agoraS = Math.floor(agoraNovo.getTime() / 1000);
  // o cartão mudou enquanto o modelo escrevia? (etapa, Pausar IA, ◷ Retomar em, etiqueta)
  const fresco = await deps.kommo.getLead(lead.id);
  const etapa = deps.funis.nomeDe(fresco.pipeline_id, fresco.status_id);
  if (!etapa || etapa.funil !== 'COMERCIAL' || !etapaDaCutucada(etapa.status)) return { tipo: 'segurou', motivo: 'o cartão saiu da entrada/qualificação enquanto o texto era escrito' };
  const quieto = porQueOCartaoFicaQuieto(fresco, { agora: agoraS, tz, pausarIaFieldId: unit.kommoPausedFieldId ?? null });
  if (quieto) return { tipo: 'segurou', motivo: `o cartão mudou enquanto o texto era escrito: ${quieto.texto}` };
  // as pausas LIDAS AGORA (a recepção pode ter pausado a unidade; a equipe, o cartão)
  if (await deps.unidadeEmPausaAgora(unit).catch(() => false)) return { tipo: 'segurou', motivo: 'a IA da unidade foi pausada enquanto o texto era escrito' };
  if (await deps.leadPausadoPorJanela(unit.id, lead.id).catch(() => true)) return { tipo: 'segurou', motivo: 'pausa com data neste cartão' };
  if (await deps.caixinhaMarcada(unit, lead.id).catch(() => false)) return { tipo: 'segurou', motivo: '«Pausar IA» foi marcado enquanto o texto era escrito' };
  // a conversa: o paciente respondeu, ou a equipe/outro falou de novo, nesse meio tempo?
  const falas = await lerFalas(unit, deps, fresco);
  const d = decidirPelaConversa(falas, agoraNovo, cfg);
  if (d.tipo !== 'cutucar' || d.ultimaDaEquipe.id !== ultima.id) {
    return { tipo: 'segurou', motivo: `a conversa mudou enquanto o texto era escrito (${d.tipo === 'pular' ? MOTIVO_DA_CONVERSA[d.porque] : 'outra fala da equipe'})` };
  }

  // o horário e a chave de AGORA (o modelo levou segundos; desligar na tela tem de valer na hora, inclusive para os envios que faltam nesta varredura)
  if (!clinicaAtendendoAgora(unit, agoraNovo)) return { tipo: 'segurou', motivo: 'a clínica fechou enquanto o texto era escrito' };
  if (!(await deps.chaveLigadaAgora(unit).catch(() => false))) return { tipo: 'segurou', motivo: 'a chave foi desligada (ou voltou para «só no papel») durante a varredura' };

  // UMA vez por lead: a marca vai ANTES do envio. Quem perde a corrida não envia.
  const marca = await deps.gravarMarca(unit, lead.id, { leadId: lead.id, texto, ultimaDaEquipe: { id: ultima.id, em: ultima.em.toISOString(), autor: ultima.autorNome }, decididaEm: agora.toISOString() });
  if (marca === 'ja_existia') return { tipo: 'segurou', motivo: 'já cutucado (outra varredura chegou primeiro)' };
  if (marca === 'erro') return { tipo: 'erro' };

  try {
    const via = await deps.kommo.sendChatReply({ leadId: lead.id, text: texto, chatId: null, talkId: null, contactId: null });
    if (via.via === 'lead_note') {
      // o paciente NÃO recebeu (sem Salesbot/rota de chat): ficou só uma nota. A marca fica — repetir empilharia nota a cada varredura.
      logger.error({ unit: unit.slug, leadId: lead.id }, 'cutucada: a mensagem virou NOTA no cartão (a unidade não tem rota de envio pelo Salesbot) — o paciente não recebeu');
      return { tipo: 'erro' };
    }
  } catch (err) {
    // NÃO solta a marca: exceção depois de o pedido partir não prova que nada saiu (timeout depois do Kommo aceitar; no modo bypass o
    // texto vai em pedaços e o 1º pode ter chegado). Duas mensagens ao paciente é pior que uma cutucada perdida. Se o João souber que
    // não saiu, libera o lead apagando a marca (consulta no corpo do PR).
    logger.error({ err: String(err), unit: unit.slug, leadId: lead.id, marca: idDaMarcaDaCutucada(unit.id, lead.id) }, 'cutucada: o envio deu erro — a marca FICA (não repete); confira no Kommo se a mensagem saiu');
    return { tipo: 'erro' };
  }
  await deps.gravarMensagem(unit, lead.id, texto, contato, { via: 'salesbot', ...META_DA_CUTUCADA }).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'cutucada: enviei, mas não gravei a mensagem no banco'),
  );
  logger.info({ unit: unit.slug, leadId: lead.id, equipeFalouEm: ultima.em.toISOString(), texto }, 'cutucada: enviada');
  return { tipo: 'enviou' };
}

// ─── o worker ─────────────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { isActive: true } });
    for (const unit of unidades) {
      const estado = estadoDaCutucada(unit.slug);
      if (estado === 'desligado') continue;
      // o barato primeiro: noite, domingo, feriado e unidade em pausa não gastam uma chamada ao Kommo (a varredura repete essas duas conferências)
      if (emPausa(unit) || !clinicaAtendendoAgora(unit, new Date())) continue;
      try {
        const deps = await depsReais(unit);
        if (!deps) continue;
        const resumo = await varrerCutucada(unit, estado, deps);
        logger.info(resumo, 'cutucada: varredura');
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug }, 'cutucada: varredura da unidade falhou');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'cutucada: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startCutucadaAposEquipeWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  primeira.unref?.();
  timer.unref?.();
  logger.info({ sweepMs: SWEEP_MS }, 'cutucada depois da equipe: worker iniciado (só age onde a chave está em «só no papel» ou ligada)');
}

export function stopCutucadaAposEquipeWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
