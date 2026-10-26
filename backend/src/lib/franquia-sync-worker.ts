/**
 * Sincronizador franquia → Kommo.
 *
 * A cada 15 min, por unidade com token da franquia e slug liberado em
 * `FRANQUIA_SYNC_SLUGS` (lista separada por vírgula; `*` = todas; vazio = desligado):
 *   1. lê os agendamentos de D-3 a D+45 e os tratamentos em andamento;
 *   2. casa cada paciente com um lead do Kommo — primeiro pelo vínculo que a
 *      Sofia já gravou (spine_lead_links), senão pelo telefone do paciente;
 *   3. fase 1: decide o que escrever com `planejarEscritas` (puro) e grava campo a campo;
 *   4. fase 2 (só em `FRANQUIA_MOVE_SLUGS`): decide com `planejarMovimento` (puro) e MOVE a
 *      etapa do cartão — mover dispara bots e o Purchase do n8n, por isso é por unidade.
 *
 * Nunca sobrescreve texto livre da SDR: só os campos listados em CAMPOS_SYNC.
 * O que a franquia não sabe, fica como está.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { escritasDoPaciente, idadeADesencalhar } from './paciente-para-cartao.js';
import { escritasDoTratamento } from './tratamento-para-cartao.js';
import { CAMPOS_SESSOES, acharCampoDeSessao, escritasDeSessoes, separarCiclo } from './sessoes-para-cartao.js';
import { planejarAtendimento, type CampoCandidato } from './atendimento-para-cartao.js';
import { abrirSessaoTela, montarAvisoDaTela, type AtendimentoTela, type ProblemaDaTela, type SessaoTela } from './franquia-tela.js';
import { avisarJoao } from './alerta-whatsapp.js';
import { planejarCamposSdr, type CampoAtual } from './campos-sdr.js';
import { fichaDoPaciente, type SpineFicha } from '../services/spine.service.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead, type KommoLeadCustomField } from '../services/kommo.service.js';
import { SPINE_STATUS, SpineService, instanteNoFuso, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { CAMPOS_SYNC, chaveTelefone, ehCabecalhoDeGrupo, ehConsulta, escolherConsulta, melhorTratamento, nomeDaFranquia, nomeParaBusca, normalizar, planejarEscritas, type CampoSync } from './franquia-sync.js';
import {
  ETAPA, JORNADA, MOTIVO_PERDA, horasAteNegociacao, estadoDoMove, planejarMovimento, precisaHistoricoDoExPaciente, sessaoEsquecidaComTratamentoFinalizado,
  tratamentoAberto, tratamentoFinalizado, type EntradaMovimento, type EtapaAtual, type Funil, type Movimento, type TratamentoParaEtapa,
} from './franquia-move.js';
import { normalizarNome } from './kommo-schema.js';
import { franquiaRespeitaEspera } from './espera-retomada.js';
import { fecharOuSegurar, seguradoPelaTrava } from './parados-worker.js';
import { TAG_SEM_REGUA, campoDoPerdidoDaFranquia, type DecisaoParado } from './parados.js';
import { automacaoLigada, estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import {
  CAMPO_ID_CLIENT, PREFIXO_CONFLITO, TAG_CONFLITO, ID_AUTOMACAO as AUTOMACAO_1610, anotarRoboPos, idsDoConflito, cartaoTravadoNoConflito, cartoesComMaisDeUmPaciente, chaveDaDevolucao, chaveDaFalta, chaveDaSujeira, chaveDaTarefaDeDevolucao,
  chaveDoRoboPos, tarefaDaSujeira,
  escolherPacienteDoCartao, estadoCasamentoJornada, faltasParaAvisar, identidadeDoPaciente, notaConflitoDeTelefone, notaDaDevolucao,
  notaDaFalta, tarefaDaDevolucao, tarefaDaFalta, type ClienteCandidato, type EscolhaDoPaciente, type EtapaQueAFranquiaReabre,
} from './casamento-jornada.js';
import { PARA_SEMPRE_MS, avisarCadastroDuplicado, cartoesComConflito, escolhaDaSdr, gravarEscolhaDaSdr, guardarCandidatos } from './conflito-paciente.js';
import { JANELA_24H_MS, avisoRecente, marcadoEm, marcarAviso } from './aviso-dedupe.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDoKommo, grupoDaUnidade, irmasSemKommoProprio, podeMexer, pularCartao, valorDaUnidadeNoCartao, veredictoDoCartao, type GrupoDoCrm } from './crm-compartilhado.js';

const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_MS = 90_000;
const DIAS_ATRAS = 3;
const DIAS_FRENTE = 45;
const MAX_PACIENTES_POR_VARREDURA = 400;
const PAUSA_ENTRE_ESCRITAS_MS = 150;
/** Gentileza com o servidor da franquia (o PHP deles é lento): uma página a cada 1,5 s. */
const PAUSA_ENTRE_LEITURAS_TELA_MS = 1500;
/** Cada cartão com sessão a atualizar custa até ~10 PATCH; o teto espalha a 1ª varredura de uma unidade grande por várias. */
const MAX_SESSOES_POR_VARREDURA = Number(process.env.FRANQUIA_SESSOES_MAX) || 60;
const CACHE_LEAD_MS = 6 * 60 * 60_000;
/** Cada atendimento lido da tela da franquia é 1 página (~300 KB): o teto espalha a 1ª varredura por várias e o cache evita reler o mesmo. */
const MAX_TELA_POR_VARREDURA = Number(process.env.FRANQUIA_TELA_MAX) || 80;
const CACHE_TELA_MS = 3 * 60 * 60_000;
const cacheTela = new Map<string, { em: number; atendimento: AtendimentoTela }>();
/** O mesmo problema só vira WhatsApp de novo depois de 6 h — a causa costuma ser uma só (senha vencida, tela mudou). */
const AVISO_TELA_INTERVALO_MS = 6 * 60 * 60_000;

async function avisarProblemaDaTela(unit: Pick<Unit, 'slug' | 'name'>, tipo: ProblemaDaTela): Promise<void> {
  await avisarJoao(montarAvisoDaTela(unit.name || unit.slug, tipo), `franquia-tela:${unit.slug}:${tipo}`, AVISO_TELA_INTERVALO_MS).catch(() => undefined);
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

/**
 * Quem está sendo varrido AGORA → quando começou (epoch ms).
 *
 * Era uma flag booleana única (`rodando`) para a varredura inteira, e isso fazia três estragos ao
 * mesmo tempo (diagnosticados pelo João em 28/09/2026): enquanto UMA unidade era varrida, toda
 * outra tentativa morria — inclusive a batida automática de 15 em 15 min —, e morria em silêncio.
 * Como cada unidade leva ~15 min e são 6, a volta completa dava ~1h30 e quem caísse no fim da fila
 * ficava sem vez. E o `soSlug` do "forçar agora" só era aplicado DENTRO do laço, depois da trava:
 * forçar Taubaté esperava a varredura inteira de outra unidade — ou seja, quase nunca funcionava.
 *
 * Sendo por unidade, duas unidades diferentes varrem em paralelo sem se atrapalhar, e o que a trava
 * impede passa a ser só o que ela sempre devia impedir: varrer a MESMA unidade duas vezes ao mesmo
 * tempo, que duplicaria escrita no Kommo.
 */
const emVoo = new Map<string, number>();

/** Quem está em voo agora, para a tela de operação dizer por que a fila não andou. */
export function varredurasEmVoo(): Array<{ unit: string; desdeMs: number }> {
  const agora = Date.now();
  return [...emVoo.entries()].map(([unit, desde]) => ({ unit, desdeMs: agora - desde }));
}

export interface LinhaDoPanorama {
  slug: string;
  nome: string;
  ligado: boolean;
  /** há quantos ms esta unidade está sendo varrida AGORA, ou null se não está */
  emVooHaMs: number | null;
  /**
   * Em quantos ms o relógio DESTA unidade dispara. Substituiu a "posição na fila": desde 29/09/2026
   * cada unidade tem o próprio relógio, então fila não existe mais e mostrá-la seria mentira.
   */
  proximaEmMs: number | null;
  vezesHoje: number;
  ultimaEm: string | null;
  ultimaMs: number | null;
  escritas: number | null;
  movimentos: number | null;
  semLead: number | null;
  erros: number | null;
}

/**
 * Tudo que a tela de operação da franquia precisa, numa chamada só: quem está rodando agora, quem
 * é o próximo, quantas vezes cada unidade já rodou hoje e o que a última passada fez.
 *
 * A `posicaoNaFila` usa a MESMA ordenação de `varrer` — se as duas divergirem, a tela mente sobre
 * quem vai primeiro, que é justamente a pergunta que ela existe para responder.
 */
export async function panoramaDoSync(): Promise<LinhaDoPanorama[]> {
  const units = await prisma.unit.findMany({ where: await ondeTemSync(), select: { slug: true, name: true } });
  const agora = Date.now();
  const ligadas = units.filter((u) => estadoDaAutomacao(u.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS) !== 'desligado');

  return units
    .map((u) => {
      const r = relogio.get(u.slug);
      const ligado = ligadas.some((l) => l.slug === u.slug);
      const desde = emVoo.get(u.slug);
      const proxima = proximaEm.get(u.slug);
      return {
        slug: u.slug,
        nome: u.name,
        ligado,
        emVooHaMs: desde === undefined ? null : agora - desde,
        proximaEmMs: proxima === undefined ? null : Math.max(0, proxima - agora),
        vezesHoje: r?.vezesHoje ?? 0,
        ultimaEm: r?.ultima?.em ?? null,
        ultimaMs: r?.ms ?? null,
        escritas: r?.ultima?.escritas ?? null,
        movimentos: r?.ultima?.movimentos ?? null,
        semLead: r?.ultima?.semLead ?? null,
        erros: r?.ultima?.erros ?? null,
      };
    })
    .sort((a, b) => Number(b.ligado) - Number(a.ligado) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

export interface ResumoSync {
  unit: string;
  em: string;
  agendamentos: number;
  tratamentos: number;
  pacientes: number;
  comLead: number;
  semLead: number;
  escritas: number;
  erros: number;
  exemplosSemLead: string[];
  /** fase 2: cartões movidos de etapa nesta varredura (0 quando a unidade não está em FRANQUIA_MOVE_SLUGS) */
  movimentos: number;
  /** fase 1c: cartões cujas sessões/tratamento foram atualizados nesta varredura (teto `MAX_SESSOES_POR_VARREDURA`) */
  sessoes?: number;
  /** fase 1d: atendimentos lidos da TELA da franquia (forma de pagamento, retorno, motivo) nesta varredura */
  tela?: number;
  /** fase 1e (teste): campos da SDR calculados — quantos gravaria, quantos conferem e quantos divergem do que a SDR pôs */
  camposSdr?: { gravaria: number; confere: number; diverge: number };
  /** cartões em que a fase 1e escreveu nesta varredura (teto `MAX_CAMPOS_SDR_POR_VARREDURA`) */
  camposSdrCartoes?: number;
  /** fase 2: cartões antigos em AGENDADO (fora da janela D-3) revisados pelo histórico do paciente (23/09/2026) */
  revisados: number;
  /** PERDIDOs que a trava da perda automática (consulta futura / pagou / Quente / Morno) segurou: o cartão fica onde está, não é erro */
  travadosPelaPerda?: number;
  /** move em seco: "DE → PARA" → quantos cartões se moveriam nesta varredura (só aparece quando há) */
  simulados?: Record<string, number>;
  /** cartões recusados porque o `⚙ idClient` deles é de OUTRO paciente (só os ids dos cartões, sem dado pessoal) */
  conflitos?: number;
  exemplosConflito?: number[];
  /** 16/10 (decisão 1): cartões travados porque dois pacientes da franquia usam o telefone deles (a SDR escolhe no widget) */
  conflitosDeTelefone?: number;
  /** 16/10 (decisão 4): faltas em retorno/sessão que viraram nota + tarefa nesta varredura */
  faltasAvisadas?: number;
  /** Kommo dividido (Petrópolis + Caxias): cartões que a franquia DESTA unidade casou, mas que são da outra */
  deOutraUnidade?: number;
  /** Kommo dividido: cartões com «⌂ Unidade de atendimento» vazio — ninguém mexe, vão para a lista da SDR */
  semUnidade?: number;
}
const ultimoResumo = new Map<string, ResumoSync>();
export function resumoDoSync(): ResumoSync[] {
  return [...ultimoResumo.values()];
}

/**
 * Relógio da varredura, por unidade — pedido do João (23/09/2026): "quero saber, dentro do Kommo,
 * há quantos minutos rodou e quantas vezes já rodou hoje". Vive na memória do processo: reiniciou o
 * serviço, a contagem do dia recomeça (e o widget diz isso com o `desde`).
 */
export interface RelogioSync {
  /** fim da última varredura desta unidade */
  ultimaEm: string | null;
  /** quanto tempo ela levou */
  ultimaMs: number | null;
  /** cartões movidos e campos gravados na última */
  ultimosMovimentos: number;
  ultimasEscritas: number;
  /** quantas varreduras desta unidade desde a virada do dia (fuso da unidade) */
  vezesHoje: number;
  /** de quantos em quantos minutos ela roda */
  intervaloMin: number;
  /** quando este processo começou a contar */
  desde: string;
}
interface EntradaRelogio {
  vezesHoje: number;
  dia: string;
  ultima: ResumoSync | null;
  ms: number | null;
  /**
   * Quando esta unidade foi TENTADA pela última vez — deu certo ou não. É por aqui que a fila
   * ordena, e a distinção importa: se ordenasse pela última varredura BEM-SUCEDIDA, uma unidade com
   * credencial vencida nunca registraria sucesso, voltaria ao topo a cada 15 min e passaria a vida
   * na frente de quem está só esperando a vez.
   */
  tentativaEpoch: number;
}
const relogio = new Map<string, EntradaRelogio>();
const processoDesde = new Date().toISOString();

function anotarVarredura(unit: Unit, r: ResumoSync, ms: number): void {
  const dia = instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 10);
  const atual = relogio.get(unit.slug);
  const vezesHoje = atual && atual.dia === dia ? atual.vezesHoje + 1 : 1;
  relogio.set(unit.slug, { vezesHoje, dia, ultima: r, ms, tentativaEpoch: Date.now() });
}

/** Carimba a tentativa mesmo quando a varredura estourou — ver `tentativaEpoch`. */
function anotarTentativa(slug: string): void {
  const atual = relogio.get(slug);
  if (atual) atual.tentativaEpoch = Date.now();
  else relogio.set(slug, { vezesHoje: 0, dia: '', ultima: null, ms: null, tentativaEpoch: Date.now() });
}

/**
 * Quando esta unidade foi tentada pela última vez. Quem nunca foi tentada devolve 0 e por isso vai
 * para a FRENTE da fila — é o que acaba com o "a última nunca chega a vez".
 */
function ultimaTentativa(slug: string): number {
  return relogio.get(slug)?.tentativaEpoch ?? 0;
}

export function relogioDoSync(slug: string): RelogioSync {
  const r = relogio.get(slug);
  return {
    ultimaEm: r?.ultima?.em ?? null,
    ultimaMs: r?.ms ?? null,
    ultimosMovimentos: r?.ultima?.movimentos ?? 0,
    ultimasEscritas: r?.ultima?.escritas ?? 0,
    vezesHoje: r?.vezesHoje ?? 0,
    intervaloMin: Math.round(SWEEP_MS / 60_000),
    desde: processoDesde,
  };
}

/**
 * paciente (nome normalizado) → lead do Kommo, por unidade; evita repetir a busca por telefone a cada 15 min.
 * `idsClient`: quem a busca mostrou ser este paciente na franquia (vazio = não se sabe) — é o que permite recusar
 * o cartão que já pertence a OUTRO paciente (`cartaoDeOutroPaciente`).
 */
const cacheLead = new Map<string, { leadId: number | null; idsClient: number[]; leadConfirmado: boolean; expiraEm: number }>();


type CampoInfo = Pick<KommoLeadCustomField, 'id' | 'type' | 'enums'>;
type MapaCampos = Partial<Record<CampoSync, CampoInfo>>;

export interface CampoBruto {
  id: number;
  name: string;
  type: string;
  enums?: Array<{ id: number; value: string }> | null;
}

/**
 * Monta o mapa a partir da lista BRUTA do Kommo. "◷ Data da Consulta" e
 * "◷ Agendado pela SDR em" são `date_time` na Imperatriz — tipo que a listagem
 * tipada descarta (foi por isso que a 1ª varredura pulou a unidade); no PATCH o
 * formato é o mesmo do `date` (unix em segundos), então gravamos como `date`.
 */
function mapearCampos(campos: CampoBruto[]): MapaCampos {
  const dados = campos.filter((c) => !ehCabecalhoDeGrupo(c.name));
  const porNome = new Map(dados.map((c) => [normalizar(c.name), c]));
  const out: MapaCampos = {};
  for (const [chave, nome] of Object.entries(CAMPOS_SYNC) as Array<[CampoSync, string]>) {
    // nome exato (com o símbolo) antes do normalizado
    const c = dados.find((x) => x.name.trim() === nome) ?? porNome.get(normalizar(nome));
    if (!c) continue;
    const type = c.type === 'date_time' ? 'date' : c.type;
    if (!['date', 'select', 'monetary', 'numeric', 'text', 'textarea', 'radiobutton'].includes(type)) continue;
    out[chave] = { id: c.id, type: type as KommoLeadCustomField['type'], enums: (c.enums ?? []).map((e) => ({ id: e.id, value: e.value })) };
  }
  return out;
}

function valoresDoLead(lead: KommoLead, mapa: MapaCampos): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [chave, nome] of Object.entries(CAMPOS_SYNC) as Array<[CampoSync, string]>) {
    const info = mapa[chave];
    if (!info) continue;
    const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === info.id);
    const v = cf?.values?.[0]?.value;
    out[nome] = v === null || v === undefined || v === '' ? null : String(v);
  }
  return out;
}

async function telefoneDoPaciente(unit: Unit, nome: string, idClient: number | null): Promise<{ fone: string; idsClient: number[] } | null> {
  if (idClient) {
    const r = await SpineService.getClient(unit, idClient);
    if (r.ok && r.data?.client?.whatsapp) return { fone: r.data.client.whatsapp, idsClient: [idClient] };
  }
  const r = await SpineService.searchClients(unit, nome);
  if (!r.ok || !r.data) return null;
  const alvo = normalizar(nome);
  const exatos = r.data.clients.filter((c) => normalizar(c.name) === alvo && c.whatsapp);
  const fones = [...new Set(exatos.map((c) => chaveTelefone(c.whatsapp)))];
  // dois pacientes homônimos com telefones diferentes: não arrisca
  if (fones.length !== 1) return null;
  // mesmo nome e mesmo telefone = o mesmo paciente (cadastro duplicado conta como ele)
  const idsClient = idClient ? [idClient] : exatos.map((c) => c.idClient).filter((x): x is number => !!x);
  return { fone: exatos[0].whatsapp as string, idsClient };
}

/**
 * O cartão daquele telefone — e se o telefone foi CONFIRMADO ou se é o mais recente por falta de
 * prova. A diferença importa para quem grava algo permanente no cartão (o `⚙ idClient`): no cartão de
 * família que divide o WhatsApp, o mais recente pode ser o da filha enquanto o paciente é a mãe.
 */
async function leadPorTelefone(kommo: KommoClient, telefone: string): Promise<{ id: number; confirmado: boolean } | null> {
  const chave = chaveTelefone(telefone);
  if (!chave) return null;
  const leads = await kommo.listLeadsPorTelefone(telefone);
  if (leads.length === 0) return null;
  const ordenados = [...leads].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (ordenados.length === 1) return { id: ordenados[0].id, confirmado: true };
  // vários leads: confirma o telefone do contato dos 3 mais recentes
  for (const l of ordenados.slice(0, 3)) {
    const contato = l._embedded?.contacts?.[0]?.id;
    if (!contato) continue;
    const fone = await kommo.getContactPhone(contato);
    if (fone && chaveTelefone(fone) === chave) return { id: l.id, confirmado: true };
  }
  return { id: ordenados[0].id, confirmado: false };
}

/**
 * Acha o cartão do paciente: primeiro pelo vínculo que a Sofia gravou, depois pelo telefone/nome.
 * Exportada porque a carga de implantação (`franquia-carga.service`) precisa da MESMA resposta para
 * saber quem ainda não tem cartão — duplicar esse casamento seria criar cartão em cima de quem já tem.
 */
/**
 * O paciente que a varredura da agenda casou com este cartão nas últimas 6 h (`cacheLead`, o mesmo de `resolverPaciente`):
 * só quando todo paciente que caiu no cartão é o MESMO idClient — dois pacientes no cartão é conflito, não atalho.
 */
function pacienteDaAgenda(unitId: string, leadId: number): number | null {
  const agora = Date.now();
  const ids = new Set<number>();
  for (const [k, v] of cacheLead) {
    if (v.leadId !== leadId || v.expiraEm <= agora || !k.startsWith(`${unitId}:`)) continue;
    if (v.idsClient.length !== 1) return null;
    ids.add(v.idsClient[0]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

export async function resolverLead(unit: Unit, kommo: KommoClient, nome: string, idClient: number | null, idsSchedule: number[]): Promise<number | null> {
  return (await resolverPaciente(unit, kommo, nome, idClient, idsSchedule)).leadId;
}

/** O cartão do paciente e quem ele é na franquia (`idsClient`, vazio quando o caminho não diz). */
async function resolverPaciente(
  unit: Unit, kommo: KommoClient, nome: string, idClient: number | null, idsSchedule: number[],
): Promise<{ leadId: number | null; idsClient: number[]; leadConfirmado: boolean }> {
  const chaveCache = `${unit.id}:${normalizar(nome)}`;
  const hit = cacheLead.get(chaveCache);
  if (hit && hit.expiraEm > Date.now()) return hit;

  let leadId: number | null = null;
  // vínculo da Sofia e id do agendamento são prova; só o telefone com vários cartões é palpite
  let leadConfirmado = true;
  let idsClient: number[] = idClient ? [idClient] : [];
  if (idsSchedule.length > 0) {
    const link = await prisma.spineLeadLink.findFirst({
      where: { unitId: unit.id, spineIdSchedule: { in: idsSchedule } },
      orderBy: { updatedAt: 'desc' },
    });
    if (link) {
      leadId = link.kommoLeadId;
      if (!idClient && link.spineIdClient) idsClient = [link.spineIdClient];
    }
  }
  if (leadId === null && idClient) {
    const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, spineIdClient: idClient }, orderBy: { updatedAt: 'desc' } });
    if (link) leadId = link.kommoLeadId;
  }
  if (leadId === null) {
    const achado = await telefoneDoPaciente(unit, nome, idClient);
    if (achado) {
      const porFone = await leadPorTelefone(kommo, achado.fone);
      leadId = porFone?.id ?? null;
      leadConfirmado = porFone?.confirmado ?? true;
      idsClient = achado.idsClient;
    }
  }
  const out = { leadId, idsClient, leadConfirmado, expiraEm: Date.now() + CACHE_LEAD_MS };
  cacheLead.set(chaveCache, out);
  return out;
}

/**
 * O `⚙ idClient (franquia)` gravado no cartão (pela carga de implantação ou pela marcação do widget), ou null. Sem os
 * campos da conta (o cadastro da Sofia não os carrega), vale o `field_name` que o Kommo manda em cada valor do cartão.
 */
export function idClientDoCartao(
  lead: Pick<KommoLead, 'custom_fields_values'>,
  campos: ReadonlyArray<readonly [string, { id: number; nome?: string }]>,
): number | null {
  const valores = lead.custom_fields_values ?? [];
  const info = campoDaConta(campos, '⚙ idClient (franquia)') ?? campos.find(([k]) => k.includes('idclient'))?.[1];
  const cf = info
    ? valores.find((f) => f.field_id === info.id)
    : campos.length === 0 ? valores.find((f) => normalizar(f.field_name).includes('idclient')) : undefined;
  const v = Number(cf?.values?.[0]?.value);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * O cartão já é de OUTRO paciente? Regra (14/10/2026, cartão 1292772 de Petrópolis recebia dois pacientes que
 * dividem o WhatsApp — idade 51↔81 e idTreatment 97775↔125923 alternando a cada varredura): cartão com
 * `⚙ idClient` só aceita esse paciente. Sem `⚙` no cartão, ou sem saber quem o paciente é, não há como
 * provar o conflito e vale o casamento de sempre.
 */
export function cartaoDeOutroPaciente(idDoCartao: number | null, idsDoPaciente: number[]): boolean {
  return idDoCartao !== null && idsDoPaciente.length > 0 && !idsDoPaciente.includes(idDoCartao);
}

function opcoes(mapa: MapaCampos) {
  const vals = (c: CampoSync) => (mapa[c]?.enums ?? []).map((e) => e.value);
  return { fisio: vals('FISIO'), categoria: vals('CATEGORIA'), tratamento: vals('TRAT_FECHADO') };
}

// ── fase 2: mover etapa ──

/** Funis e etapas da conta, pelo NOME: o principal é o COMERCIAL; o outro tem que se chamar TRATAMENTO. */
export interface Funis {
  comercialId: number;
  tratamentoId: number | null;
  status: Map<string, { id: number; nome: string }>; // chave `${funil}:${nomeNormalizado}`
  nomeDe: (pipelineId: number, statusId: number) => EtapaAtual | null;
  idDe: (funil: Funil, etapa: string) => { pipelineId: number; statusId: number } | null;
}

export async function carregarFunis(kommo: KommoClient): Promise<Funis | null> {
  const pipes = await kommo.listPipelines();
  const comercial = pipes.find((p) => p.is_main) ?? pipes.find((p) => normalizarNome(p.name) === normalizarNome('COMERCIAL'));
  if (!comercial) return null;
  const tratamento = pipes.find((p) => normalizarNome(p.name) === normalizarNome('TRATAMENTO')) ?? null;
  const status = new Map<string, { id: number; nome: string }>();
  const inverso = new Map<string, EtapaAtual>();
  const registrar = (funil: Funil, p: { id: number; statuses?: Array<{ id: number; name: string }> }) => {
    for (const s of p.statuses ?? []) {
      status.set(`${funil}:${normalizarNome(s.name)}`, { id: s.id, nome: s.name });
      inverso.set(`${p.id}:${s.id}`, { funil, status: s.name });
    }
  };
  registrar('COMERCIAL', comercial);
  if (tratamento) registrar('TRATAMENTO', tratamento);
  return {
    comercialId: comercial.id,
    tratamentoId: tratamento?.id ?? null,
    status,
    nomeDe: (pipelineId, statusId) => inverso.get(`${pipelineId}:${statusId}`) ?? null,
    idDe: (funil, etapa) => {
      const s = status.get(`${funil}:${normalizarNome(etapa)}`);
      const pipelineId = funil === 'COMERCIAL' ? comercial.id : tratamento?.id;
      return s && pipelineId ? { pipelineId, statusId: s.id } : null;
    },
  };
}

/** O detalhe do paciente (`GET /clients/{id}`): histórico + nome e telefone, que o casamento de 16/10 confere. */
interface DetalheDoPaciente {
  treatments: TratamentoParaEtapa[];
  schedules: SpineSchedule[];
  name: string | null;
  whatsapp: string | null;
}
const cacheDetalhe = new Map<string, DetalheDoPaciente & { expiraEm: number }>();
const CACHE_DETALHE_MS = 60 * 60_000;

/** O detalhe, do cache de 1 h ou da franquia. `null` = a franquia não tem esse idClient; erro da API LANÇA. */
async function detalheDoPaciente(unit: Unit, idClient: number): Promise<DetalheDoPaciente | null> {
  const k = `${unit.id}:${idClient}`;
  const hit = cacheDetalhe.get(k);
  if (hit && hit.expiraEm > Date.now()) return hit;
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok) throw new Error(`franquia clients/${idClient} falhou: ${r.error}`);
  const c = r.data?.client;
  if (!c) return null;
  if (cacheDetalhe.size > 20_000) for (const [kk, v] of cacheDetalhe) if (v.expiraEm <= Date.now()) cacheDetalhe.delete(kk);
  const out = { treatments: c.treatments, schedules: c.schedules, name: c.name, whatsapp: c.whatsapp, expiraEm: Date.now() + CACHE_DETALHE_MS };
  cacheDetalhe.set(k, out);
  return out;
}

/**
 * O `/treatments/search` só devolve o mês corrente e a agenda só D-3…D+45. Pra decidir
 * GANHO → EM TRATAMENTO e EM TRATAMENTO → ALTA precisamos do histórico do paciente,
 * que só o detalhe (`GET /clients/{id}`) traz. Uma chamada por paciente por hora.
 */
export async function historicoDoPaciente(unit: Unit, idClient: number | null): Promise<DetalheDoPaciente | null> {
  if (!idClient) return null;
  return detalheDoPaciente(unit, idClient).catch(() => null);
}

/** Todo "moveria" do seco (do move ou da revisão) conta aqui, pra o `simulados` do resumo nunca subestimar o volume. */
function contarSimulado(resumo: ResumoSync, de: string, para: string): void {
  const chave = `${de || '?'} → ${para}`;
  resumo.simulados = { ...resumo.simulados, [chave]: (resumo.simulados?.[chave] ?? 0) + 1 };
}

/** PERDIDO segurado pela trava: não relê o cartão no Kommo de novo antes disto (a varredura passa de 15 em 15 min). */
const TRAVA_REVE_A_CADA_MS = 60 * 60_000;
const travadoAte = new Map<string, number>();

/** No papel: o movimento é um PERDIDO que a trava da perda automática (consulta futura / pagou / Quente / Morno) seguraria? */
function perdaTravada(unit: Unit, cartao: KommoLead, para: string, deEtapa: string, automacao: string, agoraEpoch: number): boolean {
  return normalizarNome(para) === normalizarNome(ETAPA.PERDIDO) && seguradoPelaTrava(unit, cartao.id, cartao, deEtapa, true, automacao, agoraEpoch);
}

/**
 * `cartao` (opcional) é o cartão que o chamador já leu: em «só no papel» a trava da perda automática o usa e NUNCA relê no Kommo
 * (o seco não toca o Kommo, nem pra ler — o teste de `aplicarMovimento` em seco vigia isso).
 */
export async function aplicarMovimento(unit: Unit, kommo: KommoClient, funis: Funis, leadId: number, mov: Movimento, resumo: ResumoSync, deEtapa = '', cartao?: KommoLead): Promise<void> {
  const alvo = funis.idDe(mov.funil, mov.para);
  if (!alvo) {
    logger.warn({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil }, 'franquia-move: etapa não existe nesta conta — não movi');
    return;
  }
  // Move em seco (tela de Automações): é o ÚNICO portão por onde todo movimento passa — cartão normal,
  // passagem das 48 h e revisão do histórico —, então nenhum caminho novo escapa dele.
  if (estadoDoMove(unit.slug) === 'seco') {
    // trava da perda automática (26/10): o papel não pode prometer um PERDIDO que o ligado não faria
    if (cartao && perdaTravada(unit, cartao, mov.para, deEtapa, 'franquia-move', Math.floor(Date.now() / 1000))) return;
    contarSimulado(resumo, deEtapa, mov.para);
    logger.info({ unit: unit.slug, leadId, de: deEtapa, para: mov.para, funil: mov.funil, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: mov.semRegua }, 'franquia-move [seco]: moveria');
    registrarSimulacao(unit, 'franquia-move', { leadId, acao: 'moveria', alvo: mov.para, deEtapa, valor: mov.motivoPerda, motivo: mov.motivo });
    return;
  }
  // PERDIDO pela jornada (fato velho na franquia): mesmo fecho do worker de parados — motivo de perda + o campo ⊘
  // que a SDR lê (sem ele o cartão aparece "sem motivo"),
  // etiqueta NO_FOLLOW_UP quando o fato é velho demais pra régua, nota no cartão, confere a etapa antes.
  if (normalizarNome(mov.para) === normalizarNome(ETAPA.PERDIDO)) {
    const d: DecisaoParado = { para: 'PERDIDO', regra: mov.motivo, dias: mov.dias ?? 0, motivoPerda: mov.motivoPerda, campo: campoDoPerdidoDaFranquia(mov.motivoPerda), semRegua: mov.semRegua === true };
    const chaveTrava = `${unit.id}:${leadId}`;
    if ((travadoAte.get(chaveTrava) ?? 0) > Date.now()) {
      resumo.travadosPelaPerda = (resumo.travadosPelaPerda ?? 0) + 1; // já segurado há pouco: nem relê o cartão no Kommo
      return;
    }
    try {
      const r = await fecharOuSegurar(unit, kommo, funis, leadId, deEtapa, d, false, 'parados', cartao);
      if (r === 'fechou') {
        resumo.movimentos++;
        logger.info({ unit: unit.slug, leadId, de: deEtapa, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: d.semRegua }, 'franquia-move: cartão fechado como PERDIDO pela jornada');
      } else if (r === 'travado') {
        // não é recusa do Kommo nem erro: a trava segurou (já logada em info pelo portão). Fica contado no resumo.
        resumo.travadosPelaPerda = (resumo.travadosPelaPerda ?? 0) + 1;
        travadoAte.set(chaveTrava, Date.now() + TRAVA_REVE_A_CADA_MS);
      }
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId }, 'franquia-move: falha ao fechar como PERDIDO');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
    return;
  }
  try {
    // sem régua (ex-paciente → ALTA): a etiqueta NO_FOLLOW_UP entra ANTES da mudança, é ela que os gatilhos da etapa leem
    if (mov.semRegua) await kommo.addTag({ leadId, tags: [TAG_SEM_REGUA] }).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-move: não consegui etiquetar NO_FOLLOW_UP'));
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
    resumo.movimentos++;
    logger.info({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil, motivo: mov.motivo, semRegua: mov.semRegua === true }, 'franquia-move: cartão movido');
    // regra de 16/10: o ROBÔ pôs na ALTA (o PERDIDO é anotado no fecharComoPerdido)
    await anotarRoboPos(unit, leadId, mov.para).catch(() => undefined);
  } catch (err) {
    resumo.erros++;
    logger.warn({ err, unit: unit.slug, leadId, para: mov.para }, 'franquia-move: falha ao mover');
  }
  await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
}

/**
 * Regra das 48 h vista pelo Kommo: quem está em COMPARECEU com a consulta atendida há mais de
 * N horas e sem tratamento espelhado vai pra EM NEGOCIAÇÃO. Usa só o que a fase 1 já gravou no
 * cartão, então cobre também quem foi atendido antes da janela da agenda (D-3).
 */
/** lead → idClient resolvido por busca (positivo ou negativo), por unidade; evita repetir a busca a cada 15 min */
const cacheIdClient = new Map<string, { idClient: number | null; expiraEm: number }>();

/**
 * A busca da franquia é por TRECHO CONTÍGUO do nome: "Edvania Pardinho" não acha "EDVANIA MARIA PARDINHO",
 * "Felipe Criste" não acha "FELIPE SANTANA CRISTE", ponto final e espaço duplo derrubam. E o cartão pode
 * ter DUAS pessoas ("MARIA DA PENHA - ALEXANDRO SANT ANA": o paciente era o segundo — achado do João,
 * 23/09/2026). Então: cada pessoa do título vira um bloco de termos, do mais específico ao mais largo,
 * incluindo o SOBRENOME — a franquia escreve o primeiro nome diferente ("ALEXSANDRO" × "ALEXANDRO") e
 * só "SANT ANA" acha. Quem decide entre os candidatos é o telefone.
 */
export function termosDeBuscaDoNome(nome: string | null | undefined): string[] {
  const base = nomeParaBusca(nome);
  if (!base) return [];
  const pessoas = base.split(/\s+[/\-–]\s+|\//).map((p) => p.trim()).filter((p) => p.length >= 3);
  const termos: string[] = [];
  for (const p of pessoas) {
    const w = p.split(' ').filter(Boolean);
    termos.push(p);
    if (w.length > 2) termos.push(w.slice(0, 2).join(' '));
    if (w.length >= 2) termos.push(w.slice(-2).join(' '));
    if (w[0] && w[0].length >= 3) termos.push(w[0]);
    // o SOBRENOME sozinho: "LUVAS LINHARES" é erro de digitação de "LUCAS LINHARES" e só "LINHARES" acha.
    // Partícula ("da", "de", "dos") não serve de busca.
    const ult = w[w.length - 1];
    if (w.length >= 2 && ult && ult.length >= 4) termos.push(ult);
  }
  return [...new Set(termos)].filter((t) => t.length >= 3).slice(0, MAX_TERMOS_DE_BUSCA);
}

/** Entre cadastros DUPLICADOS do mesmo paciente (mesmo nome e telefone), fica o que tem a consulta mais recente. */
export async function escolherEntreDuplicados(unit: Unit, cands: Array<{ idClient: number | null }>): Promise<number | null> {
  let melhor: { idClient: number; epoch: number } | null = null;
  for (const c of cands) {
    if (!c.idClient) continue;
    const hist = await historicoDoPaciente(unit, c.idClient);
    const epoch = Math.max(0, ...(hist?.schedules ?? []).map((s) => (s.dateAttendanceUtc ? Date.parse(s.dateAttendanceUtc) : 0)));
    if (!melhor || epoch > melhor.epoch || (epoch === melhor.epoch && c.idClient > melhor.idClient)) melhor = { idClient: c.idClient, epoch };
  }
  return melhor?.idClient ?? null;
}

export type ClienteFranquia = { idClient: number | null; name: string | null; whatsapp: string | null };

export type EscolhaPaciente =
  | { tipo: 'achou'; idClient: number; por: 'telefone' | 'nome' }
  /** vários no mesmo telefone: quem decide é o histórico mais recente (precisa de rede) */
  | { tipo: 'desempatar'; candidatos: ClienteFranquia[] }
  | { tipo: 'nenhum'; motivo: 'sem candidatos' | 'homonimos' | 'nome nao casa' };

/**
 * PURA: dado o que a franquia devolveu, qual é o paciente deste cartão.
 *
 * Regra do João (23/09/2026): **o telefone é a medida padrão** — bateu o número, é ele, o nome não
 * importa. Sem telefone conhecido, só nome exato e único vale. E nome exato com telefone DIFERENTE
 * do que o cartão conhece é homônimo, nunca casa (a "MARIA DA PENHA" de 2019 não é a de agosto).
 *
 * `fone` e os telefones dos candidatos entram já normalizados por `chaveTelefone`; `alvos` são os
 * termos do título já normalizados por `nomeDaFranquia`.
 */
export function escolherPaciente(candidatos: ClienteFranquia[], fone: string, alvos: Set<string>): EscolhaPaciente {
  const vivos = candidatos.filter((c) => c.idClient);
  if (vivos.length === 0) return { tipo: 'nenhum', motivo: 'sem candidatos' };
  const casaNome = (c: ClienteFranquia) => alvos.has(nomeDaFranquia(c.name));
  if (fone) {
    const pf = vivos.filter((c) => chaveTelefone(c.whatsapp) === fone);
    if (pf.length === 1) return { tipo: 'achou', idClient: pf[0].idClient as number, por: 'telefone' };
    if (pf.length > 1) {
      const certo = pf.filter(casaNome);
      return { tipo: 'desempatar', candidatos: certo.length > 0 ? certo : pf };
    }
  }
  const exatos = vivos.filter((c) => casaNome(c) && (!fone || !chaveTelefone(c.whatsapp) || chaveTelefone(c.whatsapp) === fone));
  if (exatos.length === 1) return { tipo: 'achou', idClient: exatos[0].idClient as number, por: 'nome' };
  return { tipo: 'nenhum', motivo: exatos.length > 1 ? 'homonimos' : 'nome nao casa' };
}

/**
 * `fone`: telefone já conhecido (a Sofia tem o da conversa) — dispensa ir ao Kommo buscar o do contato.
 * `soPorTelefone` (a Sofia): só aceita quem bate o telefone, ignora o "não achei" do cache e nunca grava
 * negativo nele — o nome do WhatsApp ("Maria") é largo demais para casar por nome, e um negativo dela
 * travaria por 6 h o casamento por nome do sincronizador. `maxTermos` corta as buscas.
 */
export interface ExtraDaBusca {
  kommo?: KommoClient;
  contatoId?: number | null;
  fone?: string | null;
  soPorTelefone?: boolean;
  maxTermos?: number;
}

interface ResultadoDaBusca {
  /** telefone do cartão em `chaveTelefone` ('' = desconhecido) */
  fone: string;
  /** o mesmo telefone como veio (o Kommo busca pelos dígitos) */
  foneBruto: string | null;
  alvos: Set<string>;
  vistos: ClienteFranquia[];
}

/**
 * O que a busca da franquia achou para um cartão, guardado pelo mesmo tempo do cache do casamento (6 h, mais uma folga
 * para não vencer antes dele). Toda busca escreve; só as regras de 16/10 (e a simulação delas no "só no papel") leem — a
 * regra antiga continua com o próprio cache, como sempre. Guarda só os candidatos que decidem (mesmo telefone ou nome
 * exato do título): pouca memória, e a mesma resposta (achado 8 da revisão de 16/10: a simulação refazia até 10 buscas
 * por cartão a cada 15 min).
 */
const cacheBusca = new Map<string, { em: number; r: ResultadoDaBusca }>();
const CACHE_BUSCA_MS = CACHE_LEAD_MS + 15 * 60_000;
/** Quem decide de verdade (regras ligadas, widget) aceita só a busca desta varredura; a simulação aceita a de até 6 h. */
const MEMO_CURTO_MS = 10 * 60_000;

/**
 * Os candidatos da franquia para um cartão: busca por cada termo do título (a franquia NÃO busca por telefone) e para
 * assim que UM candidato bate o telefone. `null` = não há o que buscar (sem termos, ou `soPorTelefone` sem telefone) —
 * salvo `mesmoSemTermos`, que devolve a lista vazia com o telefone (as regras de 16/10 ainda olham os cartões irmãos).
 */
async function buscarCandidatos(
  unit: Unit, nome: string | null,
  extra?: ExtraDaBusca & { mesmoSemTermos?: boolean; memoMs?: number; soNomeCompleto?: boolean },
): Promise<ResultadoDaBusca | null> {
  // no cadastro (achado 1 da revisão de 16/10) só nome e sobrenome juntos: "Souza" sozinho traz a mãe da Ana Souza
  const doNome = termosDeBuscaDoNome(nome).filter((t) => !extra?.soNomeCompleto || t.trim().includes(' '));
  const termos = doNome.slice(0, extra?.maxTermos ?? MAX_TERMOS_DE_BUSCA);
  if (termos.length === 0 && !extra?.mesmoSemTermos) return null;
  // telefone do contato do Kommo × whatsapp da franquia: casa mesmo quando a SDR escreveu o nome diferente
  let foneBruto: string | null = extra?.fone ?? null;
  let fone = chaveTelefone(foneBruto);
  if (!fone && extra?.kommo && extra.contatoId) {
    try {
      foneBruto = await extra.kommo.getContactPhone(extra.contatoId);
      fone = chaveTelefone(foneBruto);
    } catch {
      fone = '';
    }
  }
  if (extra?.soPorTelefone && !fone) return null;
  const alvos = new Set(doNome.map(normalizar));
  const chaveMemo = `${unit.id}|${termos.join('/')}|${fone}`;
  if (extra?.memoMs) {
    const m = cacheBusca.get(chaveMemo);
    if (m && Date.now() - m.em < Math.min(extra.memoMs, CACHE_BUSCA_MS)) return { ...m.r, foneBruto: foneBruto ?? m.r.foneBruto };
  }
  // acumula os candidatos de TODOS os termos: parar no 1º que devolve alguém escondia o paciente
  // quando o cartão tinha dois nomes (o João achou isso no "MARIA DA PENHA - ALEXANDRO SANT ANA")
  const vistos = new Map<number, ClienteFranquia>();
  // atalho: assim que UM candidato bate o telefone, é ele — não gasta as buscas restantes
  const porFone = () => (fone ? [...vistos.values()].filter((c) => chaveTelefone(c.whatsapp) === fone) : []);
  for (const termo of termos) {
    const r = await SpineService.searchClients(unit, termo, 50);
    // erro da API não é "não achei": lança, pra ninguém guardar negativo nem mandar o cartão pra CONFERIR
    if (!r.ok || !r.data) throw new Error(`franquia clients/search falhou: ${r.ok ? 'sem dados' : r.error}`);
    for (const c of r.data.clients) if (c.idClient) vistos.set(c.idClient, c);
    // achou pelo telefone: é ele, não precisa gastar mais chamada
    if (porFone().length === 1) break;
  }
  const r: ResultadoDaBusca = { fone, foneBruto, alvos, vistos: [...vistos.values()] };
  const decidem = r.vistos.filter((c) => (fone && chaveTelefone(c.whatsapp) === fone) || alvos.has(nomeDaFranquia(c.name)));
  if (cacheBusca.size > 5_000) for (const [k, v] of cacheBusca) if (Date.now() - v.em > CACHE_BUSCA_MS) cacheBusca.delete(k);
  cacheBusca.set(chaveMemo, { em: Date.now(), r: { ...r, vistos: decidem } });
  return r;
}

async function procurarPaciente(unit: Unit, nome: string | null, extra?: ExtraDaBusca): Promise<number | null> {
  const b = await buscarCandidatos(unit, nome, extra);
  if (!b) return null;
  const escolha = escolherPaciente(b.vistos, b.fone, b.alvos);
  if (extra?.soPorTelefone && escolha.tipo === 'achou' && escolha.por !== 'telefone') return null;
  if (escolha.tipo === 'achou') return escolha.idClient;
  if (escolha.tipo === 'desempatar') return escolherEntreDuplicados(unit, escolha.candidatos);
  return null;
}

/**
 * Os pacientes dos OUTROS cartões do Kommo com o mesmo telefone — pelo `⚙ idClient` do cartão irmão ou pelo vínculo que a
 * Sofia gravou nele —, com o TÍTULO do cartão irmão como nome (é com ele que `escolherPacienteDoCartao` confere se é a
 * mesma pessoa; sem chamada à franquia). Num Kommo dividido (Petrópolis + Caxias), só os cartões desta unidade. A busca do
 * Kommo é textual (pode trazer quem só tem os dígitos no texto), então o telefone do contato de cada irmão é conferido
 * antes de valer (no máximo 3 conferências por cartão).
 */
async function irmaosPorTelefone(
  unit: Unit, kommo: KommoClient, leadId: number, foneBruto: string,
  campos: ReadonlyArray<readonly [string, { id: number; nome?: string }]>,
): Promise<ClienteCandidato[]> {
  const chave = chaveTelefone(foneBruto);
  if (!chave) return [];
  const grupo = await grupoDaUnidade(unit.id);
  const irmaos = (await kommo.listLeadsPorTelefone(foneBruto).catch(() => [] as KommoLead[]))
    .filter((l) => l.id !== leadId)
    // achado 2: o cartão de Caxias não é irmão do de Petrópolis, mesmo com o mesmo telefone
    .filter((l) => podeMexer(veredictoDoCartao(grupo, unit.id, grupo ? valorDaUnidadeNoCartao(l) : null)))
    .slice(0, 10);
  if (irmaos.length === 0) return [];
  const porCartao = new Map<number, Set<number>>();
  const anotar = (lid: number, id: number | null | undefined) => {
    if (!id) return;
    const set = porCartao.get(lid) ?? new Set<number>();
    set.add(id);
    porCartao.set(lid, set);
  };
  for (const l of irmaos) anotar(l.id, idClientDoCartao(l, campos));
  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, kommoLeadId: { in: irmaos.map((l) => l.id) }, spineIdClient: { not: null } },
    select: { kommoLeadId: true, spineIdClient: true },
  }).catch(() => [] as Array<{ kommoLeadId: number; spineIdClient: number | null }>);
  for (const k of links) anotar(k.kommoLeadId, k.spineIdClient);
  const out: ClienteCandidato[] = [];
  let conferidos = 0;
  for (const [lid, set] of porCartao) {
    if (conferidos++ >= 3) break;
    const irmao = irmaos.find((l) => l.id === lid);
    const contato = irmao?._embedded?.contacts?.[0]?.id;
    if (!contato) continue;
    const f = await kommo.getContactPhone(contato).catch(() => null);
    if (f && chaveTelefone(f) === chave) for (const id of set) out.push({ idClient: id, name: irmao?.name ?? null, whatsapp: f });
  }
  return out;
}

export interface ExtraDoCasamento extends ExtraDaBusca {
  /** `⚙ idClient (franquia)` do cartão — a SDR escolheu, a carga gravou ou o widget marcou. */
  idDoCartao?: number | null;
  /** Campos da conta, para ler o `⚙ idClient` dos cartões irmãos. */
  campos?: ReadonlyArray<readonly [string, { id: number; nome?: string }]>;
  /**
   * `cadastro` (a Sofia vai CRIAR paciente ou lead na franquia): o nome tem de bater em todo passo — o ⚙/vínculo e o
   * telefone de outra pessoa viram conflito (achado 1 da revisão de 16/10). `robo` (padrão): a regra do sincronizador.
   */
  modo?: 'robo' | 'cadastro';
  /** Até que idade a busca guardada vale (padrão: 10 min, a da varredura). A simulação do "só no papel" aceita 6 h. */
  memoMs?: number;
}

/**
 * O casamento das regras de 16/10/2026 (decisão 3): **idClient → telefone → nome**. Devolve a escolha inteira — o
 * conflito (dois pacientes diferentes no mesmo telefone, decisão 1) é resposta, não erro: quem chama marca o cartão.
 * Erro da API da franquia lança, como na regra antiga (ninguém vai pra CONFERIR por queda da franquia).
 */
export async function casarPacienteDoCartao(unit: Unit, leadId: number, nome: string | null, extra: ExtraDoCasamento = {}): Promise<EscolhaDoPaciente> {
  const cadastro = extra.modo === 'cadastro';
  // 1. idClient: o do cartão; senão o vínculo da Sofia
  let id = extra.idDoCartao && extra.idDoCartao > 0 ? extra.idDoCartao : null;
  if (!id) {
    const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
    id = link?.spineIdClient ?? null;
  }
  // decisão 3 do João: o idClient que o cartão já sabe (⚙ ou o vínculo que a Sofia/o widget gravou ao marcar) vem
  // primeiro, sem olhar o telefone — o conflito de telefone (decisão 1) é para o cartão que ainda não diz quem é
  if (id && !cadastro) return { tipo: 'achou', idClient: id, por: 'idClient' };
  // achado 8: o paciente que a varredura da agenda já casou com este cartão (pelo telefone dele) dispensa a busca
  const daAgenda = cadastro ? null : pacienteDaAgenda(unit.id, leadId);
  if (daAgenda) return { tipo: 'achou', idClient: daAgenda, por: 'telefone' };
  if (id) {
    // cadastro: o paciente do cartão só vale se o nome bater (1 GET por paciente por hora, o mesmo cache do histórico)
    const doCartao = await detalheDoPaciente(unit, id);
    if (doCartao) return escolherPacienteDoCartao({ idDoCartao: id, nomeDoCartao: doCartao.name, candidatos: [], fone: '', alvos: new Set(), nome, modo: 'cadastro' });
  }
  // 2. telefone (franquia pela busca do título; cartões irmãos quando a franquia não trouxe ninguém com o telefone) e 3. nome
  const b = await buscarCandidatos(unit, nome, { ...extra, mesmoSemTermos: true, memoMs: cadastro ? 0 : (extra.memoMs ?? MEMO_CURTO_MS), soNomeCompleto: cadastro });
  if (!b) return { tipo: 'nenhum', motivo: 'sem candidatos' };
  const franquiaTemOTelefone = !!b.fone && b.vistos.some((c) => chaveTelefone(c.whatsapp) === b.fone);
  const irmaos = !franquiaTemOTelefone && b.foneBruto && extra.kommo
    ? await irmaosPorTelefone(unit, extra.kommo, leadId, b.foneBruto, extra.campos ?? [])
    : [];
  return escolherPacienteDoCartao({ idDoCartao: null, candidatos: b.vistos, irmaos, fone: b.fone, alvos: b.alvos, nome, modo: extra.modo ?? 'robo' });
}

/**
 * idClient do paciente na franquia: pelo vínculo que a Sofia gravou; senão pelo nome do cartão sem a
 * data que a SDR escreve, casando por telefone (quando o contato é conhecido) ou por nome exato único.
 */
export async function idClientDoLead(unit: Unit, leadId: number, nome: string | null, extra?: ExtraDaBusca): Promise<number | null> {
  const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
  if (link?.spineIdClient) return link.spineIdClient;
  const chave = `${unit.id}:${leadId}`;
  const hit = cacheIdClient.get(chave);
  if (hit && hit.expiraEm > Date.now() && !(extra?.soPorTelefone && hit.idClient === null)) return hit.idClient;
  const idClient = await procurarPaciente(unit, nome, extra);
  if (idClient !== null || !extra?.soPorTelefone) cacheIdClient.set(chave, { idClient, expiraEm: Date.now() + CACHE_LEAD_MS });
  return idClient;
}

/** O paciente tem consulta (avaliação/retorno) marcada pra frente? Quem tem retorno marcado não vai pra EM NEGOCIAÇÃO (decisão do João, 18/09). */
export function temConsultaFutura(schedules: SpineSchedule[], agoraEpoch: number): boolean {
  return schedules.some((s) => {
    if (!s.dateAttendanceUtc || !ehConsulta(s)) return false;
    const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
    // REMARCADO (41) é consulta viva: a franquia muda a data no próprio registro e o paciente vem naquela data (#113)
    return Number.isFinite(t) && t > agoraEpoch && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO || s.idStatus === SPINE_STATUS.REMARCADO);
  });
}

/**
 * Regra das 48 h vista pelo Kommo: quem está em COMPARECEU com a consulta atendida há mais de
 * N horas e sem tratamento espelhado vai pra EM NEGOCIAÇÃO. Usa o que a fase 1 já gravou no
 * cartão (cobre quem foi atendido antes da janela D-3) e, quando conhece o paciente na franquia,
 * confere o histórico: retorno futuro marcado segura o cartão, mesmo além dos 45 dias da agenda.
 */
async function passarNegociacao(unit: Unit, kommo: KommoClient, funis: Funis, mapa: MapaCampos, resumo: ResumoSync, extra: { grupo?: GrupoDoCrm | null; seco?: boolean; campos?: CampoDaConta[] } = {}): Promise<void> {
  const compareceu = funis.idDe('COMERCIAL', ETAPA.COMPARECEU);
  if (!compareceu) return;
  const horas = horasAteNegociacao();
  const agora = Math.floor(Date.now() / 1000);
  for (let page = 1; page <= 20; page++) {
    const leads = await kommo.listLeadsPorEtapa(compareceu.pipelineId, compareceu.statusId, 250, page);
    if (leads.length === 0) break;
    for (const lead of leads) {
      const v = valoresDoLead(lead, mapa);
      const dataConsulta = Number(v[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
      const situacao = normalizar(v[CAMPOS_SYNC.SITUACAO]);
      const fechou = normalizar(v[CAMPOS_SYNC.FECHOU_TRAT]) === 'sim' || !!v[CAMPOS_SYNC.TRAT_FECHADO];
      if (!Number.isFinite(dataConsulta) || situacao !== 'atendido' || fechou) continue;
      if ((agora - dataConsulta) / 3600 < horas) continue;
      if (pularCartao(extra.grupo ?? null, unit.id, lead, resumo)) continue;
      try {
        const doCartao = estadoCasamentoJornada(unit.slug) === 'ligado' ? idClientDoCartao(lead, extra.campos ?? []) : null;
        const idClient = doCartao ?? (await idClientDoLead(unit, lead.id, lead.name ?? null));
        const hist = await historicoDoPaciente(unit, idClient);
        // retorno marcado OU tratamento ainda aberto (pendente/em andamento) segura; cancelado e finalizado não (achado do Codex, 18/09)
        if (hist && (temConsultaFutura(hist.schedules, agora) || hist.treatments.some(tratamentoAberto))) continue;
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'franquia-move: não consegui conferir a franquia antes das 48 h — seguindo pelo cartão');
      }
      const mov: Movimento = { funil: 'COMERCIAL', para: ETAPA.NEGOCIACAO, motivo: `atendido há ${Math.floor((agora - dataConsulta) / 3600)} h sem tratamento (pelo cartão)` };
      if (extra.seco) {
        contarSimulado(resumo, ETAPA.COMPARECEU, mov.para);
        logger.info({ unit: unit.slug, leadId: lead.id, de: ETAPA.COMPARECEU, para: mov.para, motivo: mov.motivo }, 'franquia-sync [seco]: moveria');
        registrarSimulacao(unit, 'franquia-sync', { leadId: lead.id, acao: 'moveria', alvo: mov.para, deEtapa: ETAPA.COMPARECEU, motivo: mov.motivo });
        continue;
      }
      await aplicarMovimento(unit, kommo, funis, lead.id, mov, resumo, ETAPA.COMPARECEU, lead);
    }
    if (leads.length < 250) break;
  }
}

export type CampoDaConta = [string, { id: number; /** nome cru, com o símbolo */ nome?: string; type: KommoLeadCustomField['type']; /** tipo como o Kommo diz (date_time continua date_time; `type` o mapeia pra date) */ rawType?: string; enums: Array<{ id: number; value: string }> }];

interface CtxSync {
  unit: Unit;
  kommo: KommoClient;
  funis: Funis | null;
  mapa: MapaCampos;
  ops: ReturnType<typeof opcoes>;
  agoraEpoch: number;
  resumo: ResumoSync;
  /**
   * Todos os campos de lead da conta, indexados pelo nome normalizado. O `mapa` acima só
   * conhece os campos da CONSULTA; o espelho da PESSOA precisa de outros sete, e criar uma
   * segunda constante só pra eles duplicaria a mesma lista em dois lugares.
   */
  camposPorNome?: CampoDaConta[];
  /** Sessão na tela da franquia, aberta na primeira vez que um cartão precisa dela (login por varredura, por unidade). */
  tela?: { sessao: SessaoTela | null; aberta: boolean };
  /** `FRANQUIA_REVISAO_SECO=1`: a revisão pelo histórico só registra o que faria (campos e etapa); a varredura normal não muda */
  seco?: boolean;
  /** Ficha (`GET /api/clients/{id}`) já lida NESTA varredura, por idClient: o mesmo paciente não custa duas chamadas. */
  fichas?: Map<number, Promise<SpineFicha | null>>;
  /**
   * Cartões que a varredura normal já processou nesta passagem.
   *
   * O fechamento das sessões (`fecharSessoesDoTratamento`) precisa saber disto para NÃO tocar nos
   * mesmos cartões: ele lê só a ficha do paciente, e a varredura normal lê a AGENDA mais a ficha —
   * duas contas diferentes do mesmo tratamento. Em 24/10/2026, na Açailândia, o lead 27223392 ficou
   * recebendo 8 (da varredura, com a sessão que só a agenda traz) e 7 (do fechamento) a cada 17
   * minutos, para sempre. Quem está na agenda é da varredura; o fechamento cuida de quem saiu dela.
   */
  tocados?: Set<number>;
  /** Em que automação o "gravaria" do seco aparece na tela: o sincronizador em seco usa a dele; a revisão, a dela. */
  automacaoDoSeco?: 'franquia-sync' | 'franquia-revisao';
  /** Kommo dividido com outra unidade (Petrópolis + Caxias): só mexe nos cartões do rótulo desta. `null` = Kommo só dela. */
  grupo?: GrupoDoCrm | null;
  /** Chave `casamento-jornada` (regras de 16/10/2026) nesta unidade. Ausente = desligado (o comportamento de sempre). */
  jornada?: Estado;
  /**
   * Cartões com conflito de telefone GUARDADO no banco (marca `conflito-franquia:`): é esta marca que trava o cartão, não a
   * etiqueta — a etiqueta é só o aviso para a SDR e pode não ter sido gravada (Kommo fora). Lida 1× por varredura.
   */
  conflitosGuardados?: Set<number>;
}

function revisaoSeca(raw: string | undefined = process.env.FRANQUIA_REVISAO_SECO): boolean {
  return /^(1|true|sim)$/i.test((raw ?? '').trim());
}

type Historico = NonNullable<Awaited<ReturnType<typeof historicoDoPaciente>>>;

interface PacienteDoCartao {
  nome: string;
  idClient: number | null;
  consultas: SpineSchedule[];
  tratamento: SpineTreatment | null;
  /** Quem a varredura casou com o cartão (`resolverPaciente`), quando se sabe — dispensa buscar de novo. */
  idsClient?: number[];
}

/**
 * Os campos do cartão que a ficha da franquia preenche — e cujo BURACO justifica ler a ficha.
 *
 * Saíram três (14/10/2026), porque mantinham o "tem buraco" verdadeiro para sempre e a ficha era relida a
 * cada 15 min (~400 GET/h só em Petrópolis): `# Sessões previstas` (quem grava é `sessoes-para-cartao`, não
 * este caminho), `# Nº de faltas em sessão` (vazio é o normal — quem nunca faltou não ganha "0") e
 * `⚕ Tratamento fechado` (a fase 1 o espelha a cada varredura; onde é texto, como em Petrópolis, a ficha não
 * tem opção para casar). Quando a ficha é lida por outro buraco, os três continuam sendo preenchidos.
 */
const CAMPOS_PESSOA = [
  '⚥ Sexo', '◷ Data de nascimento', '# Idade', '⌂ Endereço',
  '⌂ Cidade', '⌂ Estado', '⚑ Origem na franquia', '✓ Status do paciente',
  // O bloco TRATAMENTO vem da mesma ficha — se algum destes está vazio, vale a chamada.
  '✎ Queixa', '¤ Valor do tratamento', '⚕ Fisioterapeuta',
  '◷ Última sessão marcada', '✓ Compareceu à última sessão marcada',
] as const;

/**
 * Buracos que a ficha lida NÃO tapou, por cartão + paciente: a franquia não tem o dado (sem endereço, preço 0,
 * sem avaliação) ou a conta não aceita o valor. Reler a cada 15 min não muda isso — volta a valer a leitura
 * depois de `CACHE_SEM_DADO_MS`, ou na hora se aparecer buraco NOVO (a SDR apagou um campo).
 */
const semDadoNaFicha = new Map<string, { campos: Set<string>; expiraEm: number }>();
const CACHE_SEM_DADO_MS = 6 * 60 * 60_000;

type InfoCampo = CampoDaConta[1];

/** Campo da conta pelo nome: o EXATO (com o símbolo) primeiro; o normalizado só quando não há exato. */
export function campoDaConta<T extends { nome?: string }>(campos: ReadonlyArray<readonly [string, T]>, nome: string): T | undefined {
  const exato = campos.find(([, i]) => i.nome?.trim() === nome);
  if (exato) return exato[1];
  const chave = normalizar(nome);
  return campos.find(([k]) => k === chave)?.[1];
}

/** A ficha do paciente, lida no máximo UMA vez por varredura (o erro também fica guardado: não insiste). */
function fichaDaVarredura(ctx: CtxSync, idClient: number): Promise<SpineFicha | null> {
  ctx.fichas ??= new Map();
  let lida = ctx.fichas.get(idClient);
  if (!lida) {
    lida = fichaDoPaciente(ctx.unit as never, idClient)
      .then((r) => (r.ok && r.data?.ficha ? r.data.ficha : null))
      .catch(() => null);
    ctx.fichas.set(idClient, lida);
  }
  return lida;
}

/**
 * Espelha a PESSOA da franquia no cartão: sexo, nascimento, endereço, origem e status.
 *
 * A ficha completa custa UMA chamada por paciente (`/api/clients/{id}`), então só vale a
 * pena buscá-la quando há buraco que ela ainda possa tapar. Cartão cheio — ou com buraco que
 * a franquia já mostrou não ter como tapar (`semDadoNaFicha`) — é pulado sem chamada nenhuma.
 *
 * O preço dessa economia, dito na cara: enquanto tudo estiver preenchido, uma correção
 * feita na franquia (sexo trocado, endereço atualizado) não chega aqui. Quem pega esse
 * caso é o validador de cartão, não este caminho.
 */
async function espelharPaciente(ctx: CtxSync, leadId: number, lead: KommoLead, idClient: number): Promise<void> {
  const { unit, kommo, resumo, seco } = ctx;
  const bruto = (lead.custom_fields_values ?? []);
  const campos = ctx.camposPorNome ?? [];
  const achar = (campo: string): InfoCampo | undefined => campoDaConta(campos, campo);
  const valorAtual = (campo: string): string | null => {
    const info = achar(campo);
    if (!info) return null;
    const cf = bruto.find((f) => f.field_id === info.id);
    const v = cf?.values?.[0]?.value;
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
  };

  // A idade primeiro, e de graça: ela se corrige a partir da data que já está no cartão,
  // sem consultar a franquia. É o que impede "45" de continuar lá depois do aniversário.
  const idade = idadeADesencalhar(valorAtual);
  if (idade) {
    const info = achar(idade.campo);
    if (info && !seco) {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, idade.valor, info.enums)
        .then(() => { resumo.escritas++; logger.info({ unit: unit.slug, leadId, valor: idade.valor }, 'franquia-sync: idade recalculada'); })
        .catch((err) => { resumo.erros++; logger.warn({ err, unit: unit.slug, leadId }, 'franquia-sync: falha ao recalcular idade'); });
    } else if (info && seco) {
      logger.info({ unit: unit.slug, leadId, valor: idade.valor }, 'franquia-sync [seco]: recalcularia idade');
      registrarSimulacao(unit, 'franquia-revisao', { leadId, acao: 'gravaria', alvo: idade.campo, valor: idade.valor, motivo: 'idade pela data de nascimento' });
    }
  }

  const chaveSemDado = `${unit.id}:${leadId}:${idClient}`;
  const lembrado = semDadoNaFicha.get(chaveSemDado);
  const semDado = lembrado && lembrado.expiraEm > Date.now() ? lembrado.campos : null;
  const buracos = CAMPOS_PESSOA.filter((c) => achar(c) && valorAtual(c) === null);
  if (!buracos.some((c) => !semDado?.has(c))) return;

  const ficha = await fichaDaVarredura(ctx, idClient);
  if (!ficha) return;

  /** O que ficou gravado nesta passada; o resto dos buracos vira "sem dado" e não pede a ficha de novo tão cedo. */
  const gravados = new Set<string>();
  const lembrarSemDado = () => {
    if (semDadoNaFicha.size > 20_000) for (const [k, v] of semDadoNaFicha) if (v.expiraEm <= Date.now()) semDadoNaFicha.delete(k);
    semDadoNaFicha.set(chaveSemDado, { campos: new Set(buracos.filter((c) => !gravados.has(c))), expiraEm: Date.now() + CACHE_SEM_DADO_MS });
  };

  const opcoesProtocolo = (achar('⚕ Tratamento fechado')?.enums ?? []).map((x) => x.value);
  const planejadas = [
    ...escritasDoPaciente(ficha, valorAtual),
    ...escritasDoTratamento({
      sessoes: ficha.schedules as never,
      tratamento: (ficha.treatments?.[0] ?? null) as never,
      opcoesProtocolo,
      valorAtual,
    }),
  ];
  for (const e of planejadas) {
    const info = achar(e.campo);
    if (!info) continue;
    if (!e.sobrescreve && valorAtual(e.campo) !== null) continue;
    // Campo de lista só aceita opção que EXISTE naquela conta. A franquia manda o nome do
    // fisioterapeuta que atendeu, e cada clínica tem a sua equipe — em Divinópolis isso
    // virou 400 NotSupportedChoice em série. Mesmo contrato do backfill-campos: não
    // inventa opção, pula e registra.
    if (['select', 'multiselect', 'radiobutton'].includes(info.type) && info.enums.length) {
      const existe = info.enums.some((x) => normalizar(x.value) === normalizar(String(e.valor)));
      if (!existe) {
        logger.info(
          { unit: unit.slug, leadId, campo: e.campo, valor: e.valor },
          'franquia-sync: opção não existe nesta conta — não gravei',
        );
        continue;
      }
    }
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-sync [seco]: gravaria campo da pessoa');
      registrarSimulacao(unit, 'franquia-revisao', { leadId, acao: 'gravaria', alvo: e.campo, valor: e.valor, motivo: e.motivo });
      continue;
    }
    try {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      gravados.add(e.campo);
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-sync: campo da pessoa gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-sync: falha ao gravar campo da pessoa');
    }
    await new Promise((r2) => setTimeout(r2, PAUSA_ENTRE_ESCRITAS_MS));
  }
  lembrarSemDado();
}

/**
 * Sessões e tratamento no cartão (fase 1c), ATUALIZADOS a cada varredura — o `espelharPaciente` só
 * preenche buraco, o que é certo para queixa e errado para contador (ver `sessoes-para-cartao.ts`).
 *
 * Os contadores só saem do histórico COMPLETO do paciente (`GET /clients/{id}`, cache de 1 h): a
 * agenda da varredura cobre D-3…D+45 e contar só ela diria "2 realizadas" para quem fez 14 sessões.
 * Sem o histórico em mãos grava apenas o que é do tratamento (id, local, grau, status).
 */
/**
 * O que o espelho das sessões precisa saber do paciente — menos do que `PacienteDoCartao`, porque o
 * fechamento (abaixo) monta o tratamento a partir da ficha, e a ficha não traz local, grau nem criação.
 */
type PacienteParaSessoes = Pick<PacienteDoCartao, 'nome' | 'idClient' | 'consultas'> & {
  tratamento: (Pick<SpineTreatment, 'idTreatment' | 'local' | 'degree' | 'statusName' | 'created'> & { category?: string | null }) | null;
};

async function espelharSessoes(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteParaSessoes, historico: Historico | null): Promise<void> {
  const { unit, kommo, resumo, agoraEpoch } = ctx;
  if (!p.tratamento?.idTreatment) return;
  // Chave por unidade (tela de Automações): desligado = não faz nada; seco = só registra o que gravaria.
  const estado = estadoDaAutomacao(unit.slug, 'franquia-sessoes', process.env.FRANQUIA_SESSOES_SLUGS);
  if (estado === 'desligado') return;
  const seco = estado === 'seco' || ctx.seco === true;
  if ((resumo.sessoes ?? 0) >= MAX_SESSOES_POR_VARREDURA) return;
  const hist = historico ?? (p.idClient ? await historicoDoPaciente(unit, p.idClient) : null);
  const ids = new Set(p.consultas.map((s) => s.idSchedule));
  const schedules = hist ? [...p.consultas, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))] : [];

  if (seco && hist) {
    // Prova em produção de uma dúvida em aberto: a ficha do paciente manda o id do tratamento em cada sessão?
    // Se `comIdTratamento` vier 0, a separação de ciclos cai na data de criação do tratamento.
    const doHistorico = hist.schedules.filter((s) => !ehConsulta(s));
    logger.info(
      { unit: unit.slug, leadId, sessoesNoHistorico: doHistorico.length, comIdTratamento: doHistorico.filter((s) => s.idTreatment !== null).length },
      'franquia-sync [seco]: sessões do histórico do paciente',
    );
  }

  const porNome = new Map(ctx.camposPorNome ?? []);
  const bruto = lead.custom_fields_values ?? [];
  const campo = (nome: string) => {
    const info = acharCampoDeSessao(porNome, nome, normalizar);
    if (!info) return null;
    const v = bruto.find((f) => f.field_id === info.id)?.values?.[0]?.value;
    return { tipo: info.rawType ?? (info.type as string), valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v) };
  };

  const tratamentosDoPaciente = hist?.treatments;
  if (!separarCiclo(p.tratamento.idTreatment, tratamentosDoPaciente, p.tratamento, p.tratamento.created != null).separavel) {
    logger.info(
      { unit: unit.slug, leadId, idTreatment: p.tratamento.idTreatment, tratamentos: tratamentosDoPaciente?.length },
      'franquia-sessoes: mais de um tratamento e não sei de qual é cada sessão — não gravo contador',
    );
  }
  const planejadas = escritasDeSessoes({ schedules, tratamento: p.tratamento, tratamentosDoPaciente, agoraEpoch, campo });
  if (planejadas.length > 0) resumo.sessoes = (resumo.sessoes ?? 0) + 1;
  for (const e of planejadas) {
    const info = acharCampoDeSessao(porNome, e.campo, normalizar);
    if (!info) continue;
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.limpar ? '(limpar)' : e.valor, motivo: e.motivo }, 'franquia-sync [seco]: gravaria sessão/tratamento');
      registrarSimulacao(unit, estado === 'seco' ? 'franquia-sessoes' : (ctx.automacaoDoSeco ?? 'franquia-revisao'), { leadId, acao: 'gravaria', alvo: e.campo, valor: e.limpar ? '(limpar)' : e.valor, noCartao: campo(e.campo)?.valor, motivo: e.motivo });
      continue;
    }
    try {
      if (e.limpar) await kommo.clearLeadCustomField(leadId, info.id);
      else await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.limpar ? '(limpar)' : e.valor, motivo: e.motivo }, 'franquia-sync: sessão/tratamento gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-sync: falha ao gravar sessão/tratamento');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/** As etapas onde o tratamento já aconteceu: o paciente saiu da agenda, e por isso o cartão parava no tempo. */
const ETAPAS_DO_TRATAMENTO: ReadonlyArray<readonly [Funil, string]> = [
  ['TRATAMENTO', ETAPA.EM_TRATAMENTO],
  ['TRATAMENTO', ETAPA.ALTA],
  ['COMERCIAL', ETAPA.RETORNO],
] as const;

/**
 * As sessões do cartão que já está EM TRATAMENTO, ALTA ou RETORNO PÓS deixam de congelar.
 *
 * A varredura parte da AGENDA (D-3…D+45): quem termina o tratamento sai da janela e o contador fica
 * no número do dia em que saiu. Medido na Açailândia em 23/10/2026: o cartão dizia 7 sessões e a
 * franquia tinha 8; outro dizia 23 contra 24, os dois com o tratamento já FINALIZADO. A revisão pelo
 * histórico não alcança isso — ela varre o COMERCIAL e DECIDE ETAPA, e mexer na etapa de quem está em
 * ALTA dispararia os templates de parabéns meses depois.
 *
 * Então esta passada só escreve CAMPO, e só onde não há nada a adivinhar:
 *  - cartão que já sabe quem é (`⚙ idClient` gravado) — nenhuma busca por nome, nenhuma chamada a mais
 *    além da ficha do paciente, que tem cache de 1 h;
 *  - o tratamento que o PRÓPRIO cartão afirma (`⚙ idTreatment`), se a ficha ainda o tem. Quem voltou
 *    depois da alta tem outro ciclo aberto, e reescrever o cartão com ele trocaria o histórico de um
 *    tratamento pelo de outro;
 *  - mesma chave `franquia-sessoes`, mesmo seco e mesmo teto por varredura do espelho normal.
 */
async function fecharSessoesDoTratamento(ctx: CtxSync): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  if (estadoDaAutomacao(unit.slug, 'franquia-sessoes', process.env.FRANQUIA_SESSOES_SLUGS) === 'desligado') return;
  const porNome = new Map(ctx.camposPorNome ?? []);
  const infoTrat = acharCampoDeSessao(porNome, CAMPOS_SESSOES.ID_TRAT, normalizar);
  const infoStatus = acharCampoDeSessao(porNome, CAMPOS_SESSOES.STATUS_TRAT, normalizar);
  if (!infoTrat) return;
  // As ETAPAS, não o move: esta passada só escreve campo, e precisa rodar justamente onde a
  // movimentação está desligada — que é quase toda a rede desde 05/10/2026. Sem isto, `ctx.funis` vem
  // nulo com o move desligado e o fechamento nunca aconteceria onde ele mais importa.
  const funis = ctx.funis ?? (await carregarFunis(kommo));
  if (!funis) return;

  // Orçamento PRÓPRIO: o teto de `resumo.sessoes` é gasto primeiro pelo laço da agenda, e com um
  // contador só as etapas do fim da lista (ALTA, RETORNO PÓS) nunca chegariam a ser atendidas.
  const daPassada: ResumoSync = { ...resumo, escritas: 0, erros: 0, sessoes: 0 };
  const ctxDaPassada: CtxSync = { ...ctx, funis, resumo: daPassada };
  try {
    for (const [funil, etapa] of ETAPAS_DO_TRATAMENTO) {
      const alvo = funis.idDe(funil, etapa);
      if (!alvo) continue;
      for (let page = 1; page <= 20; page++) {
        if ((daPassada.sessoes ?? 0) >= MAX_SESSOES_POR_VARREDURA) break;
        const leads = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true);
        if (leads.length === 0) break;
        for (const lead of leads) {
          if ((daPassada.sessoes ?? 0) >= MAX_SESSOES_POR_VARREDURA) break;
          if (pularCartao(ctx.grupo ?? null, unit.id, lead, daPassada)) continue;
          // Cartão que a varredura normal já tratou nesta passagem é dela: ela conta com a agenda na
          // mão, o fechamento só com a ficha, e os dois gravando o mesmo campo viram regravação a cada
          // 17 min (lead 27223392, Açailândia, 24/10/2026).
          if (ctx.tocados?.has(lead.id)) continue;
          const idClient = idClientDoCartao(lead, ctx.camposPorNome ?? []);
          if (!idClient) continue;
          const valorDe = (id: number) => String((lead.custom_fields_values ?? []).find((f) => f.field_id === id)?.values?.[0]?.value ?? '');
          const noCartao = Number(valorDe(infoTrat.id));
          if (!Number.isInteger(noCartao) || noCartao <= 0) continue;
          // Tratamento que o cartão já mostra FINALIZADO não muda toda hora: fechar uma vez e reler só
          // uma vez por semana. Sem este freio seriam `GET /clients/{id}` para TODO cartão em ALTA a
          // cada hora (o cache do detalhe é de 1 h), numa fila que só cresce — e a franquia já reclamou
          // de volume em 05/10/2026.
          const chaveFechado = `fechamento-sessoes:${noCartao}`;
          // Só tratamento FINALIZADO: é dele que vem o congelamento (acabou, saiu da agenda, ninguém
          // mais olha). Tratamento em andamento tem sessão marcada, logo está na agenda, e ali quem
          // conta é a varredura normal — que tem mais dado do que esta passada.
          if (normalizar(infoStatus ? valorDe(infoStatus.id) : '') !== 'finalizado') continue;
          if (await avisoRecente(unit.id, lead.id, chaveFechado, 7 * JANELA_24H_MS)) continue;
          const hist = await historicoDoPaciente(unit, idClient);
          const tratamento = (hist?.treatments ?? []).find((t) => t.idTreatment === noCartao);
          if (!hist || !tratamento) continue;
          // A ficha do paciente NÃO manda o `created` do tratamento (só idTreatment, idStatus, statusName
          // e typeName) e, medido na Imperatriz e na Açailândia (0 de 1.238 sessões), também não manda o
          // idTreatment de cada sessão. O que ela manda é o RÓTULO em cada sessão ("PROTOCOLO 03 MESES -
          // LOMBAR"), igual ao `typeName` do tratamento sem o grau: com ele dá para separar os
          // tratamentos que correm juntos. Sem rótulo próprio, ou com dois tratamentos de rótulo igual
          // (renovação — e aqui não há `created`), não há como saber de quem é cada sessão: não fecho.
          const ciclo = separarCiclo(tratamento.idTreatment ?? null, hist.treatments, null, false);
          if (!ciclo.separavel) {
            logger.info(
              { unit: unit.slug, leadId: lead.id, tratamentos: hist.treatments.length },
              'franquia-sessoes: mais de um tratamento e sessão sem como separar — não fecho, contaria o tratamento errado',
            );
            continue;
          }
          // `local` e `degree` não vêm na ficha; vazio não grava campo nenhum (o gravador ignora texto
          // vazio), então o que a varredura normal já escreveu ali fica como está.
          const doCiclo = { idTreatment: tratamento.idTreatment ?? null, local: null, degree: null, statusName: tratamento.statusName ?? null, created: null };
          const antes = daPassada.sessoes ?? 0;
          await espelharSessoes(ctxDaPassada, lead.id, lead, { nome: lead.name ?? '', idClient, consultas: [], tratamento: doCiclo }, hist).catch((err) =>
            logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'franquia-sessoes: fechamento falhou neste cartão'),
          );
          // marca só depois de gravar de verdade, e só o que não muda mais
          if ((daPassada.sessoes ?? 0) > antes && !ctx.seco) await marcarAviso(unit.id, lead.id, chaveFechado);
        }
        if (leads.length < 250) break;
      }
    }
  } finally {
    resumo.escritas += daPassada.escritas;
    resumo.erros += daPassada.erros;
    resumo.sessoes = (resumo.sessoes ?? 0) + (daPassada.sessoes ?? 0);
  }
}

/**
 * Atendimento da franquia no cartão (fase 1d): forma de pagamento, data do retorno e motivo para não realizar o
 * tratamento, lidos da TELA de edição do atendimento — a API não os devolve. Só para quem já foi atendido
 * (avaliação ou retorno com desfecho ATENDIDO). Detalhes e regras em `atendimento-para-cartao.ts`.
 *
 * Chave `franquia-tela` (tela de Automações): desligado não faz nada; seco registra o que gravaria. O login vem de
 * FRANQUIA_TELA_USER/FRANQUIA_TELA_PASS; sem ele a fase inteira é pulada com um aviso.
 */
async function espelharAtendimento(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  const estado = estadoDaAutomacao(unit.slug, 'franquia-tela', process.env.FRANQUIA_TELA_SLUGS);
  if (estado === 'desligado' || !ctx.tela) return;
  const seco = estado === 'seco' || ctx.seco === true;

  const consulta = escolherConsulta(p.consultas);
  if (!consulta?.idSchedule || consulta.idStatus !== SPINE_STATUS.ATENDIDO) return;

  const chave = `${unit.slug}:${consulta.idSchedule}`;
  let atendimento = cacheTela.get(chave);
  if (!atendimento || Date.now() - atendimento.em > CACHE_TELA_MS) {
    if ((resumo.tela ?? 0) >= MAX_TELA_POR_VARREDURA) return;
    if (!ctx.tela.aberta) {
      ctx.tela.aberta = true;
      ctx.tela.sessao = await abrirSessaoTela(unit.slug);
      if (!ctx.tela.sessao) await avisarProblemaDaTela(unit, 'entrar');
    }
    if (!ctx.tela.sessao || ctx.tela.sessao.quebrada || ctx.tela.sessao.layoutMudou) return;
    const lido = await ctx.tela.sessao.lerAtendimento(consulta.idSchedule);
    if (!lido) {
      if (ctx.tela.sessao.quebrada) await avisarProblemaDaTela(unit, 'sessao');
      else if (ctx.tela.sessao.layoutMudou) await avisarProblemaDaTela(unit, 'layout');
      return;
    }
    resumo.tela = (resumo.tela ?? 0) + 1;
    atendimento = { em: Date.now(), atendimento: lido };
    if (cacheTela.size > 500) for (const [k, v] of cacheTela) if (Date.now() - v.em > CACHE_TELA_MS) cacheTela.delete(k);
    cacheTela.set(chave, atendimento);
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_LEITURAS_TELA_MS));
  }

  const bruto = lead.custom_fields_values ?? [];
  const campos = (nome: string): CampoCandidato[] =>
    (ctx.camposPorNome ?? [])
      .filter(([chaveNome]) => chaveNome === normalizar(nome))
      .map(([, info]) => {
        const v = bruto.find((f) => f.field_id === info.id)?.values?.[0]?.value;
        return {
          id: info.id,
          tipo: info.rawType ?? (info.type as string),
          valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v),
          opcoes: info.enums.map((x) => x.value),
        };
      });

  const plano = planejarAtendimento({ atendimento: atendimento.atendimento, campos, fuso: unit.spineTimezone || 'America/Sao_Paulo' });
  for (const aviso of plano.avisos) logger.info({ unit: unit.slug, leadId, aviso }, 'franquia-tela: não gravei');

  for (const e of plano.escritas) {
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-tela [seco]: gravaria atendimento');
      registrarSimulacao(unit, estado === 'seco' ? 'franquia-tela' : (ctx.automacaoDoSeco ?? 'franquia-revisao'), { leadId, acao: 'gravaria', alvo: e.campo, valor: e.valor, motivo: e.motivo });
      continue;
    }
    const info = (ctx.camposPorNome ?? []).map(([, i]) => i).find((i) => i.id === e.id);
    if (!info) continue;
    try {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-tela: atendimento gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-tela: falha ao gravar atendimento');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/** Linha de teste já registrada neste processo: o mesmo "gravaria/confere/diverge" não se repete a cada 15 min. */
const comparacoesVistas = new Set<string>();
/** Teto de cartões com escrita por varredura: a 1ª vez que liga numa unidade grande não pode segurar o move. */
const MAX_CAMPOS_SDR_POR_VARREDURA = Number(process.env.CAMPOS_SDR_MAX) || 60;

function jaRegistrou(chave: string): boolean {
  if (comparacoesVistas.has(chave)) return true;
  comparacoesVistas.add(chave);
  // apara as mais antigas (o Set guarda a ordem de entrada) em vez de esvaziar tudo e repetir o log inteiro
  if (comparacoesVistas.size > 20_000) {
    let n = 0;
    for (const k of comparacoesVistas) { comparacoesVistas.delete(k); if (++n >= 5_000) break; }
  }
  return false;
}

/**
 * Campos que a SDR preenchia à mão (fase 1e, em TESTE): Tipo de lead, Responsável agendamento e Data de
 * solicitação de cancelamento. Regras e decisões em `campos-sdr.ts`.
 *
 * Chave `campos-sdr` (tela de Automações): desligado não faz nada; seco registra o que gravaria; ligado grava SÓ
 * em campo vazio. Nos dois modos registra se o calculado CONFERE ou DIVERGE do que a SDR já pôs — é o teste em
 * produção antes de aprovar.
 */
async function espelharCamposSdr(
  ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao, consulta: SpineSchedule | null, feitoPelaIa: boolean,
): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  const estado = estadoDaAutomacao(unit.slug, 'campos-sdr', process.env.CAMPOS_SDR_SLUGS);
  // a cópia do Tipo de lead (Tipo de agendamento/fechamento) tem chave própria: liga/testa sem mexer nas outras
  const estadoTipos = estadoDaAutomacao(unit.slug, 'campos-sdr-tipos', process.env.CAMPOS_SDR_TIPOS_SLUGS);
  if (estado === 'desligado' && estadoTipos === 'desligado') return;
  const secoDe = (r: { copia?: true }) => (r.copia ? estadoTipos : estado) === 'seco' || ctx.seco === true;

  const bruto = lead.custom_fields_values ?? [];
  const porNome = ctx.camposPorNome ?? [];
  // Nome exato (com o símbolo) primeiro: a normalização tira o "⬢" e "Tipo de lead" antigo casaria com o novo.
  const info = (nome: string) => {
    const mesmos = porNome.filter(([k]) => k === normalizar(nome)).map(([, i]) => i);
    return mesmos.find((i) => i.nome === nome) ?? mesmos[0] ?? null;
  };
  const campo = (nome: string): CampoAtual | null => {
    const i = info(nome);
    if (!i) return null;
    const v = bruto.find((f) => f.field_id === i.id)?.values?.[0]?.value;
    return { valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v), opcoes: i.enums.map((x) => x.value) };
  };
  const carimbo = Number(campo('◷ Agendado pela SDR em')?.valor);
  const temCarimbo = Number.isFinite(carimbo) && carimbo > 0;
  const dataConsulta = consulta?.dateAttendanceUtc ? Math.floor(Date.parse(consulta.dateAttendanceUtc) / 1000) : NaN;

  const primeiroContato = Number(campo('◷ Data do primeiro contato')?.valor);
  const plano = planejarCamposSdr({
    campo,
    nome: lead.name,
    criadoEmEpoch: lead.created_at ?? null,
    primeiroContatoEpoch: Number.isFinite(primeiroContato) && primeiroContato > 0 ? primeiroContato : null,
    // quando chegou ao agendamento: o carimbo; sem ele, a data da consulta. Nunca "agora".
    referenciaEpoch: temCarimbo ? carimbo : Number.isFinite(dataConsulta) ? dataConsulta : null,
    primeiraVez: !temCarimbo,
    consulta,
    feitoPelaIa,
    tratamento: p.tratamento,
    copiarTipos: estadoTipos !== 'desligado',
  }).filter((r) => (r.copia ? estadoTipos : estado) !== 'desligado');
  if (plano.length === 0) return;
  resumo.camposSdr ??= { gravaria: 0, confere: 0, diverge: 0 };
  const vaiEscrever = plano.some((r) => r.acao === 'gravar' && !secoDe(r));
  if (vaiEscrever && (resumo.camposSdrCartoes ?? 0) >= MAX_CAMPOS_SDR_POR_VARREDURA) return;
  if (vaiEscrever) resumo.camposSdrCartoes = (resumo.camposSdrCartoes ?? 0) + 1;

  for (const r of plano) {
    const rotulo = r.copia ? 'campos-sdr-tipos' : 'campos-sdr';
    if (r.acao !== 'gravar') {
      resumo.camposSdr[r.acao]++;
      if (!jaRegistrou(`${unit.slug}:${leadId}:${r.campo}:${r.acao}:${r.noCartao}`)) {
        logger.info({ unit: unit.slug, leadId, campo: r.campo, calculado: r.valor, noCartao: r.noCartao, motivo: r.motivo }, `${rotulo}: ${r.acao}`);
      }
      registrarSimulacao(unit, rotulo, { leadId, acao: r.acao, alvo: r.campo, valor: r.valor, noCartao: r.noCartao, motivo: r.motivo });
      continue;
    }
    resumo.camposSdr.gravaria++;
    if (secoDe(r)) {
      if (!jaRegistrou(`${unit.slug}:${leadId}:${r.campo}:gravaria:${r.valor}`)) {
        logger.info({ unit: unit.slug, leadId, campo: r.campo, valor: r.valor, motivo: r.motivo }, `${rotulo} [seco]: gravaria`);
      }
      registrarSimulacao(unit, rotulo, { leadId, acao: 'gravaria', alvo: r.campo, valor: r.valor, motivo: r.motivo });
      continue;
    }
    const i = info(r.campo);
    if (!i) continue;
    try {
      await kommo.setLeadCustomFieldValue(leadId, i.id, i.type, r.valor, i.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: r.campo, valor: r.valor, motivo: r.motivo }, `${rotulo}: gravado`);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: r.campo }, `${rotulo}: falha ao gravar`);
    }
    await new Promise((res) => setTimeout(res, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/** Etiqueta que a SDR filtra no Kommo: o cartão tem um paciente no `⚙ idClient` e a franquia casou OUTRO com ele. */
export { TAG_CONFLITO };

/**
 * Grava no cartão QUEM ele é na franquia (`⚙ idClient`), quando a agenda acabou de provar isso.
 *
 * A varredura casa paciente e cartão pelo telefone da agenda e jogava esse resultado fora a cada
 * passagem — só a carga de implantação e o widget escreviam o campo. Fora da janela D-3…D+45 não há
 * agenda, e aí só resta procurar pelo nome: na Açailândia, em 23/10/2026, 0 de 224 cartões em
 * tratamento tinham o campo e 21 de 25 não casavam mais ("nome nao casa", "homonimos" — títulos como
 * "MARCILENE/Maria dos Anjos 19/01"). O cartão congela no número do dia em que saiu da janela: dizia
 * 7 sessões realizadas, a franquia tinha 8.
 *
 * Escreve UMA vez por cartão e nunca sobrescreve: idClient diferente no cartão é conflito, e disso
 * cuida o `recusarOutroPaciente` — que só passa a funcionar de verdade quando este campo existe.
 */
async function gravarIdClientNoCartao(ctx: CtxSync, leadId: number, idClient: number): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  const info = campoDaConta(ctx.camposPorNome ?? [], CAMPO_ID_CLIENT);
  // Conta nascida de outra versão do cartão pode ter este campo como texto ou seleção: gravar número
  // ali dá 400 do Kommo, e o erro voltaria a cada 15 min em todo cartão, sem nunca se resolver. Os
  // outros dois lugares que escrevem este campo (widget e cadastro) também fixam `numeric`.
  if (!info || info.type !== 'numeric') return;
  // `casamento-jornada` em "só no papel" NÃO grava: a chave promete que tudo segue como antes, e este
  // campo é permanente — ninguém o sobrescreve depois, de propósito.
  if (ctx.seco || ctx.jornada !== 'ligado') {
    registrarSimulacao(unit, ctx.automacaoDoSeco ?? AUTOMACAO_1610, {
      leadId, acao: 'gravaria', alvo: CAMPO_ID_CLIENT, valor: idClient,
      motivo: 'a agenda da franquia casou este paciente com o cartão',
    });
    return;
  }
  try {
    await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, idClient, info.enums);
    resumo.escritas++;
    logger.info({ unit: unit.slug, leadId, idClient }, 'franquia-sync: ⚙ idClient gravado no cartão');
  } catch (err) {
    resumo.erros++;
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: não consegui gravar o ⚙ idClient');
  }
}

function notaConflito(idDoCartao: number, idsDoPaciente: number[]): string {
  return `⚠ Conflito de cadastro: este cartão é do paciente idClient ${idDoCartao} da franquia (campo ⚙ idClient), mas outro paciente da franquia (idClient ${idsDoPaciente.join('/')}) casou com ele — em geral, por dividir o mesmo WhatsApp. O sincronizador NÃO grava os dados do outro paciente aqui. Se o cartão é mesmo do ${idDoCartao}, nada a fazer neste cartão (o outro paciente precisa do cartão dele). Se é do outro, corrija o ⚙ idClient. A etiqueta ${TAG_CONFLITO} volta sozinha enquanto o conflito existir.`;
}

/**
 * Recusa o cartão quando o `⚙ idClient` dele é de outro paciente: nada é gravado (campos, pessoa, sessões, etapa).
 * Fica registrado para a SDR — etiqueta + uma nota, só quando a etiqueta ainda não está no cartão (não repete a
 * cada 15 min nem a cada deploy) — e no resumo/log só com ids, sem nome nem telefone.
 */
async function recusarOutroPaciente(ctx: CtxSync, leadId: number, lead: KommoLead, idsDoPaciente: number[]): Promise<boolean> {
  const { unit, kommo, resumo } = ctx;
  const idDoCartao = idClientDoCartao(lead, ctx.camposPorNome ?? []);
  if (idDoCartao === null || !cartaoDeOutroPaciente(idDoCartao, idsDoPaciente)) return false;
  resumo.conflitos = (resumo.conflitos ?? 0) + 1;
  resumo.exemplosConflito ??= [];
  if (resumo.exemplosConflito.length < 8 && !resumo.exemplosConflito.includes(leadId)) resumo.exemplosConflito.push(leadId);
  if (!jaRegistrou(`conflito:${unit.slug}:${leadId}:${idsDoPaciente.join(',')}`)) {
    logger.warn({ unit: unit.slug, leadId, idClientDoCartao: idDoCartao, idClientDaFranquia: idsDoPaciente }, 'franquia-sync: conflito — o cartão é de outro paciente da franquia; não gravei');
  }
  // 16/10 (decisão 1): a SDR já escolheu este paciente no widget → recusa o outro calado, sem etiqueta nem nota de novo
  if (ctx.jornada === 'ligado' && (await escolhaDaSdr(unit.id, leadId)) === idDoCartao) return true;
  const jaMarcado = (lead._embedded?.tags ?? []).some((t) => t.name === TAG_CONFLITO);
  if (jaMarcado) return true;
  if (ctx.seco) {
    registrarSimulacao(unit, ctx.automacaoDoSeco ?? 'franquia-revisao', { leadId, acao: 'gravaria', alvo: TAG_CONFLITO, motivo: 'cartão de outro paciente da franquia' });
    return true;
  }
  try {
    await kommo.addTag({ leadId, tags: [TAG_CONFLITO] });
    await kommo.addLeadNote(leadId, notaConflito(idDoCartao, idsDoPaciente));
    // a mesma varredura pode trazer o paciente de novo (agenda + revisão): o objeto do cartão já sabe da etiqueta
    lead._embedded = { ...lead._embedded, tags: [...(lead._embedded?.tags ?? []), { id: 0, name: TAG_CONFLITO }] };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: não consegui marcar o conflito no cartão');
  }
  return true;
}

/**
 * 16/10 (decisão 1): dois pacientes DIFERENTES da franquia no telefone deste cartão (e o cartão ainda não diz quem é,
 * pelo `⚙ idClient`). Nada é gravado; a etiqueta CONFLITO_FRANQUIA e uma nota (só na primeira vez deste conflito — tirar a
 * etiqueta à mão não traz a nota de novo) pedem à SDR que escolha no widget; os candidatos ficam guardados para o widget
 * oferecer. Sem dois idClient conhecidos não há o que escolher: não etiqueta (achado 7 da revisão), só não grava. Log e
 * resumo só com ids.
 */
async function marcarConflitoDeTelefone(ctx: CtxSync, leadId: number, lead: KommoLead, pacientes: Array<{ idClient: number | null; nome?: string | null }>): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  resumo.conflitosDeTelefone = (resumo.conflitosDeTelefone ?? 0) + 1;
  const ids = [...new Set(pacientes.map((p) => p.idClient).filter((x): x is number => !!x))];
  if (!jaRegistrou(`conflito-telefone:${unit.slug}:${leadId}:${ids.join(',')}`)) {
    logger.warn({ unit: unit.slug, leadId, idsClient: ids, pacientes: pacientes.length }, 'franquia-sync: dois pacientes no mesmo telefone — cartão travado até a SDR escolher');
  }
  // o widget só oferece quem tem idClient: com menos de dois, a etiqueta nunca sairia (achado 7)
  if (ids.length < 2) return;
  if (ctx.seco || ctx.jornada !== 'ligado') {
    registrarSimulacao(unit, AUTOMACAO_1610, { leadId, acao: 'etiquetaria', alvo: TAG_CONFLITO, valor: ids.join(', '), motivo: `${pacientes.length} pacientes da franquia no mesmo telefone` });
    return;
  }
  // a trava é a marca no banco (o widget também lê dela os candidatos); etiqueta e nota são o aviso, cada um na sua tentativa
  await guardarCandidatos(unit.id, leadId, ids);
  ctx.conflitosGuardados?.add(leadId);
  if (!(lead._embedded?.tags ?? []).some((t) => t.name === TAG_CONFLITO)) {
    try {
      await kommo.addTag({ leadId, tags: [TAG_CONFLITO] });
      lead._embedded = { ...lead._embedded, tags: [...(lead._embedded?.tags ?? []), { id: 0, name: TAG_CONFLITO }] };
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: não consegui pôr a etiqueta do conflito de telefone (o cartão segue travado pela marca)');
    }
  }
  if (await avisoRecente(unit.id, leadId, CHAVE_NOTA_CONFLITO, PARA_SEMPRE_MS)) return;
  try {
    await kommo.addLeadNote(leadId, notaConflitoDeTelefone(pacientes));
    await marcarAviso(unit.id, leadId, CHAVE_NOTA_CONFLITO);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: não consegui deixar a nota do conflito de telefone — tento na próxima');
  }
}

/** Marca de "a nota do conflito de telefone já foi para este cartão" (uma vez por conflito; a faxina apaga com ele). */
const CHAVE_NOTA_CONFLITO = 'conflito-nota';

/** Os cartões desta unidade com conflito de telefone guardado (1 consulta ao banco). Falha de banco = nenhum. */
async function cartoesComConflitoGuardado(unitId: string): Promise<Set<number>> {
  return cartoesComConflito([unitId]).catch(() => new Set<number>());
}

/** De quanto em quanto tempo a faxina dos conflitos roda por unidade (lê o Kommo e a franquia de cada cartão marcado). */
const FAXINA_CONFLITOS_MS = 60 * 60_000;
const FAXINA_CONFLITOS_MAX = 30;
const ultimaFaxina = new Map<string, number>();

/**
 * Achado 7 da revisão de 16/10: a etiqueta CONFLITO_FRANQUIA que a regra de 16/10 pôs (o cartão tem a marca
 * `conflito-franquia:` em card_alert) sai quando o conflito some — antes ela ficava para sempre e o cartão nunca mais era
 * atualizado. Uma vez por hora por unidade, no máximo 30 cartões:
 *  - chave desligada ou "só no papel": a regra não vale, então a marca dela sai (a etiqueta, se o cartão não tem ⚙ — com
 *    ⚙, uma etiqueta que esteja lá é do conflito antigo, "⚙ de outro paciente", e fica);
 *  - ligada e o cartão já tem ⚙ idClient (a SDR escolheu no widget ou gravou à mão): é a escolha — tira a etiqueta e anota
 *    a escolha (o outro paciente passa a ser recusado calado);
 *  - ligada e sem ⚙: confere na franquia (cache de 1 h) se ainda há dois pacientes com o telefone do cartão; se não há,
 *    tira a etiqueta e a marca, e o cartão volta a ser atualizado.
 * O sincronizador inteiro em "só no papel" só registra o que tiraria.
 */
async function faxinarConflitos(ctx: CtxSync, marcadosAgora: ReadonlySet<number> = new Set()): Promise<void> {
  const { unit, kommo } = ctx;
  if (Date.now() - (ultimaFaxina.get(unit.id) ?? 0) < FAXINA_CONFLITOS_MS) return;
  ultimaFaxina.set(unit.id, Date.now());
  const linhas = await prisma.cardAlert
    .findMany({ where: { unitId: unit.id, ruleKey: { startsWith: PREFIXO_CONFLITO } }, select: { leadId: true, ruleKey: true } })
    .catch(() => [] as Array<{ leadId: string; ruleKey: string }>);
  for (const l of linhas.slice(0, FAXINA_CONFLITOS_MAX)) {
    const leadId = Number(l.leadId);
    // o conflito que esta varredura acabou de ver não é conferido de novo agora
    if (!Number.isInteger(leadId) || leadId <= 0 || marcadosAgora.has(leadId)) continue;
    try {
      const lead = await kommo.getLead(leadId);
      const temEtiqueta = (lead._embedded?.tags ?? []).some((t) => t.name === TAG_CONFLITO);
      const idDoCartao = idClientDoCartao(lead, ctx.camposPorNome ?? []);
      let motivo: string | null = null;
      let tirarEtiqueta = temEtiqueta && idDoCartao === null;
      if (ctx.jornada !== 'ligado') {
        motivo = 'a regra de 16/10 não está ligada nesta unidade';
      } else if (idDoCartao !== null) {
        motivo = `o cartão já diz o paciente (⚙ idClient ${idDoCartao})`;
        tirarEtiqueta = temEtiqueta;
      } else {
        const contato = lead._embedded?.contacts?.[0]?.id;
        const fone = contato ? chaveTelefone(await kommo.getContactPhone(contato)) : '';
        if (!fone) continue;
        let noTelefone = 0;
        for (const id of idsDoConflito(l.ruleKey)) {
          const d = await detalheDoPaciente(unit, id);
          if (d && chaveTelefone(d.whatsapp) === fone) noTelefone++;
        }
        if (noTelefone < 2) motivo = 'os pacientes não dividem mais o telefone do cartão';
      }
      if (!motivo) continue;
      if (ctx.seco) {
        registrarSimulacao(unit, AUTOMACAO_1610, { leadId, acao: 'gravaria', alvo: `etiqueta ${TAG_CONFLITO}`, valor: '(tirar)', motivo });
        continue;
      }
      if (tirarEtiqueta) await kommo.removeTag(leadId, TAG_CONFLITO);
      if (ctx.jornada === 'ligado' && idDoCartao !== null) await gravarEscolhaDaSdr(unit.id, leadId, idDoCartao);
      await prisma.cardAlert.deleteMany({ where: { unitId: unit.id, leadId: String(leadId), ruleKey: { startsWith: PREFIXO_CONFLITO } } });
      await prisma.cardAlert.deleteMany({ where: { unitId: unit.id, leadId: String(leadId), ruleKey: CHAVE_NOTA_CONFLITO } });
      ctx.conflitosGuardados?.delete(leadId);
      logger.info({ unit: unit.slug, leadId, tirouEtiqueta: tirarEtiqueta, motivo }, 'casamento-jornada: conflito de telefone resolvido — marca removida');
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: faxina do conflito falhou neste cartão — tento na próxima');
    }
  }
}

/**
 * "Só no papel" das regras de 16/10 na revisão: o robô agiu pelo casamento antigo; aqui ele registra na tela quando o
 * casamento novo (idClient → telefone → nome) daria outro paciente, ou travaria o cartão por conflito.
 */
/** Cartão já simulado (casamento de 16/10, "só no papel"): não simula de novo por 6 h — cada simulação custa buscas. */
const simuladoEm = new Map<string, number>();

async function simularCasamento(ctx: CtxSync, lead: KommoLead, idDoCartao: number | null, antigo: number | null, travado: boolean): Promise<void> {
  const { unit, kommo } = ctx;
  const chave = `${unit.id}:${lead.id}`;
  if (Date.now() - (simuladoEm.get(chave) ?? 0) < CACHE_LEAD_MS) return;
  if (simuladoEm.size > 20_000) for (const [k, em] of simuladoEm) if (Date.now() - em >= CACHE_LEAD_MS) simuladoEm.delete(k);
  simuladoEm.set(chave, Date.now());
  if (travado) {
    registrarSimulacao(unit, AUTOMACAO_1610, { leadId: lead.id, acao: 'pularia', alvo: 'revisão do cartão', motivo: `cartão com ${TAG_CONFLITO} e sem ⚙ idClient: espera a SDR escolher` });
    return;
  }
  try {
    const novo = await casarPacienteDoCartao(unit, lead.id, lead.name ?? null, { kommo, contatoId: lead._embedded?.contacts?.[0]?.id ?? null, idDoCartao, campos: ctx.camposPorNome ?? [], memoMs: CACHE_BUSCA_MS });
    if (novo.tipo === 'conflito') {
      registrarSimulacao(unit, AUTOMACAO_1610, { leadId: lead.id, acao: 'etiquetaria', alvo: TAG_CONFLITO, valor: novo.candidatos.map((c) => c.idClient).join(', '), motivo: 'dois pacientes da franquia no mesmo telefone (hoje o robô escolhe sozinho)' });
      return;
    }
    const id = novo.tipo === 'achou' ? novo.idClient : null;
    if (novo.tipo === 'achou' && id !== antigo) {
      registrarSimulacao(unit, AUTOMACAO_1610, { leadId: lead.id, acao: 'diverge', alvo: 'paciente da franquia', valor: id, noCartao: antigo, motivo: `regras de 16/10 casariam por ${novo.por}${antigo ? '' : ' (hoje o cartão iria pra CONFERIR)'}` });
    }
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'casamento-jornada [seco]: não consegui simular o casamento');
  }
}

/** Falta em retorno/sessão já virou tarefa: não repete nunca para a mesma consulta (a marca vive em `card_alert`). */
const FALTA_JANELA_MS = 365 * 24 * 3600_000;

/**
 * 16/10 (decisão 4): falta em RETORNO ou SESSÃO não move o cartão — vira nota + tarefa para a SDR ligar e remarcar.
 * Uma vez por consulta. Em "só no papel" (desta chave, ou do sincronizador) só registra o que avisaria.
 */
async function avisarFaltas(ctx: CtxSync, leadId: number, lead: KommoLead, etapa: string, agendamentos: SpineSchedule[]): Promise<void> {
  const { unit, kommo, resumo, agoraEpoch } = ctx;
  if (!ctx.jornada || ctx.jornada === 'desligado') return;
  for (const f of faltasParaAvisar({ agendamentos, etapa, agoraEpoch })) {
    const chave = chaveDaFalta(f.s.idSchedule as number);
    if (ctx.jornada === 'seco' || ctx.seco) {
      registrarSimulacao(unit, AUTOMACAO_1610, { leadId, acao: 'alertaria', alvo: chave, deEtapa: etapa, motivo: tarefaDaFalta(f) });
      continue;
    }
    if (await avisoRecente(unit.id, leadId, chave, FALTA_JANELA_MS)) continue;
    try {
      await kommo.createTask({ leadId, text: tarefaDaFalta(f), completeAt: Math.floor(Date.now() / 1000) + 3600, responsibleUserId: lead.responsible_user_id });
      await marcarAviso(unit.id, leadId, chave);
      await kommo.addLeadNote(leadId, notaDaFalta(f)).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: nota da falta não foi'));
      resumo.faltasAvisadas = (resumo.faltasAvisadas ?? 0) + 1;
      logger.info({ unit: unit.slug, leadId, idSchedule: f.s.idSchedule, tipo: f.tipo }, 'casamento-jornada: falta em retorno/sessão virou tarefa (etapa não mudou)');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: não consegui criar a tarefa da falta');
    }
  }
}

/**
 * 16/10 (achado 4 da revisão): o tratamento está FINALIZADO na franquia, nenhum em andamento, e ainda há sessão marcada pra
 * frente. Antes isso tirava o cartão da ALTA (EM TRATAMENTO) e, passada a data, devolvia à ALTA — a régua de parabéns
 * disparava de novo. Agora a máquina não move por isso (`planejarMovimento` exige tratamento em andamento) e a SDR recebe
 * UMA tarefa por sessão para a clínica desmarcar a sessão ou reabrir o tratamento. Em "só no papel", só registra.
 */
async function avisarSujeira(ctx: CtxSync, leadId: number, lead: KommoLead, atual: EtapaAtual, agendamentos: SpineSchedule[], tratamentos: TratamentoParaEtapa[]): Promise<void> {
  const { unit, kommo, resumo, agoraEpoch } = ctx;
  if (!ctx.jornada || ctx.jornada === 'desligado' || atual.funil !== 'TRATAMENTO') return;
  if (normalizarNome(atual.status) === normalizarNome(ETAPA.CANCELADO)) return;
  const s = sessaoEsquecidaComTratamentoFinalizado({ agendamentos, tratamentos, agoraEpoch });
  if (!s) return;
  const chave = chaveDaSujeira(s.idSchedule ?? s.dateAttendanceUtc ?? '?');
  if (ctx.jornada === 'seco' || ctx.seco) {
    registrarSimulacao(unit, AUTOMACAO_1610, { leadId, acao: 'alertaria', alvo: chave, deEtapa: atual.status, motivo: tarefaDaSujeira(s) });
    return;
  }
  if (await avisoRecente(unit.id, leadId, chave, PARA_SEMPRE_MS)) return;
  try {
    await kommo.createTask({ leadId, text: tarefaDaSujeira(s), completeAt: Math.floor(Date.now() / 1000) + 3600, responsibleUserId: lead.responsible_user_id });
    await marcarAviso(unit.id, leadId, chave);
    logger.info({ unit: unit.slug, leadId, idSchedule: s.idSchedule }, 'casamento-jornada: tratamento finalizado com sessão marcada — tarefa aberta, cartão não move');
  } catch (err) {
    resumo.erros++;
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: não consegui abrir a tarefa da sessão esquecida');
  }
}

/**
 * 16/10 (decisão 7, resposta do João): "a franquia manda" tira o cartão de PERDIDO ou ALTA — mas UMA vez por fato. Se alguém
 * puser o cartão de volta com o mesmo fato de pé na franquia (a mesma consulta marcada, a sessão marcada), o robô deixa onde
 * a pessoa pôs e abre UMA tarefa para conferir: não repete o movimento e não dispara de novo os robôs da etapa.
 *
 * O "já tirei uma vez" mora na tabela `card_alert` (unit_id, lead_id, rule_key = `franquia-manda:<ETAPA>:<fato>`), a mesma
 * do dedupe de avisos — durável, sobrevive a deploy e a troca de processo. A marca só é gravada depois que o Kommo aceitou
 * o movimento; a da tarefa (`franquia-manda-tarefa:…`), depois que a tarefa foi criada.
 */
async function franquiaMandaUmaVez(ctx: CtxSync, leadId: number, lead: KommoLead, atual: EtapaAtual, mov: Movimento): Promise<void> {
  const { unit, kommo, funis, resumo } = ctx;
  if (!funis || !mov.gatilho) return;
  // move em seco: o aplicarMovimento só registra "moveria" — nada a marcar
  if (estadoDoMove(unit.slug) === 'seco') {
    await aplicarMovimento(unit, kommo, funis, leadId, mov, resumo, atual.status, lead);
    return;
  }
  const etapa: EtapaQueAFranquiaReabre = normalizarNome(atual.status) === normalizarNome(ETAPA.ALTA) ? 'ALTA' : 'PERDIDO';
  const chave = chaveDaDevolucao(etapa, mov.gatilho);
  const devolvidoEm = await marcadoEm(unit.id, leadId, chave);
  if (devolvidoEm && Date.now() - devolvidoEm.getTime() < PARA_SEMPRE_MS) {
    // achado 3 da revisão de 16/10: se quem pôs de volta foi um ROBÔ (depois da devolução), não é a equipe insistindo —
    // não abre a tarefa "a equipe pôs de volta" e também não insiste (dois robôs não ficam se empurrando)
    const roboPosEm = await marcadoEm(unit.id, leadId, chaveDoRoboPos(etapa));
    if (roboPosEm && roboPosEm.getTime() > devolvidoEm.getTime()) {
      if (!jaRegistrou(`robo-pos:${unit.slug}:${leadId}:${chave}`)) {
        logger.info({ unit: unit.slug, leadId, etapa, gatilho: mov.gatilho }, 'franquia-move: um robô pôs o cartão de volta — não insisto nem abro tarefa');
      }
      return;
    }
    const chaveTarefa = chaveDaTarefaDeDevolucao(etapa, mov.gatilho);
    if (await avisoRecente(unit.id, leadId, chaveTarefa, PARA_SEMPRE_MS)) return;
    try {
      await kommo.createTask({ leadId, text: tarefaDaDevolucao(etapa, mov.gatilho), completeAt: Math.floor(Date.now() / 1000) + 3600, responsibleUserId: lead.responsible_user_id });
      await marcarAviso(unit.id, leadId, chaveTarefa);
      logger.info({ unit: unit.slug, leadId, etapa, gatilho: mov.gatilho }, 'franquia-move: a equipe pôs o cartão de volta — não insisto, abri tarefa para conferir');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-move: não consegui abrir a tarefa de conferir');
    }
    return;
  }
  const antes = resumo.movimentos;
  await aplicarMovimento(unit, kommo, funis, leadId, mov, resumo, atual.status, lead);
  if (resumo.movimentos === antes) return; // o Kommo recusou (ou a trava da perda segurou): sem marca, tenta de novo na próxima varredura
  await marcarAviso(unit.id, leadId, chave);
  await kommo.addLeadNote(leadId, notaDaDevolucao(etapa, mov.para, mov.gatilho)).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-move: nota da devolução não foi'),
  );
}

/**
 * Um cartão: fase 1 (campos espelhando a franquia) e fase 2 (etapa pela máquina de `planejarMovimento`).
 * `historico` = detalhe do paciente já em mãos (a revisão dos antigos traz; a varredura normal só busca
 * quando a etapa exige — GANHO e funil TRATAMENTO).
 */
async function processarCartao(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao, historico: Historico | null = null): Promise<void> {
  const { unit, kommo, funis, mapa, ops, agoraEpoch, resumo, seco } = ctx;
  ctx.tocados?.add(leadId);
  const consulta = escolherConsulta(p.consultas);
  const consultaEpoch = consulta?.dateAttendanceUtc ? Math.floor(Date.parse(consulta.dateAttendanceUtc) / 1000) : null;
  const feitoPelaIa = consulta?.idSchedule
    ? !!(await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdSchedule: consulta.idSchedule } }))
    : false;
  const escritas = planejarEscritas({ valores: valoresDoLead(lead, mapa), consulta, consultaEpoch: Number.isFinite(consultaEpoch as number) ? consultaEpoch : null, tratamento: p.tratamento, feitoPelaIa, agoraEpoch, opcoes: ops });
  for (const w of escritas) {
    const info = mapa[w.campo];
    if (!info) continue;
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: w.nome, valor: w.limpar ? '(limpar)' : w.valor, motivo: w.motivo }, 'franquia-sync [seco]: gravaria campo');
      registrarSimulacao(unit, ctx.automacaoDoSeco ?? 'franquia-revisao', { leadId, acao: 'gravaria', alvo: w.nome, valor: w.limpar ? '(limpar)' : w.valor, motivo: w.motivo });
      continue;
    }
    try {
      if (w.limpar) await kommo.clearLeadCustomField(leadId, info.id);
      else await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, w.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: w.nome, valor: w.limpar ? '(limpar)' : w.valor, motivo: w.motivo }, 'franquia-sync: campo gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: w.nome }, 'franquia-sync: falha ao gravar campo');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }

  // fase 1b: a PESSOA (sexo, nascimento, endereço, origem, status)
  if (p.idClient) {
    await espelharPaciente(ctx, leadId, lead, p.idClient).catch((err) =>
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho da pessoa falhou'),
    );
  }

  // fase 1c: sessões e tratamento, atualizados
  await espelharSessoes(ctx, leadId, lead, p, historico).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho das sessões falhou'),
  );

  // fase 1d: forma de pagamento, retorno e motivo, lidos da tela do atendimento
  await espelharAtendimento(ctx, leadId, lead, p).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho do atendimento falhou'),
  );

  // fase 1e (teste em seco): campos que a SDR preenchia — tipo de lead, responsável, data do cancelamento
  await espelharCamposSdr(ctx, leadId, lead, p, consulta, feitoPelaIa).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: campos da SDR falharam'),
  );

  // fase 2: a franquia move o cartão
  if (!funis) return;
  const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
  if (!atual) return;
  let agendamentos: SpineSchedule[] = p.consultas;
  // o /treatments/search não traz idStatus; o nome do status basta ("EM ANDAMENTO", "FINALIZADO")
  let tratamentos: TratamentoParaEtapa[] = p.tratamento ? [{ idStatus: null, statusName: p.tratamento.statusName ?? null }] : [];
  // GANHO e EM TRATAMENTO dependem do histórico inteiro (sessão antiga, tratamento de outro mês)
  const precisaHistorico = historico !== null || normalizarNome(atual.status) === normalizarNome(ETAPA.GANHO) || atual.funil === 'TRATAMENTO';
  if (precisaHistorico) {
    // a agenda não traz idClient e o /treatments/search só lista tratamento em andamento:
    // quem finalizou some da lista — sem isto a ALTA nunca dispararia
    // 16/10: com a chave ligada, o `⚙ idClient` do cartão vem antes de qualquer busca (decisão 3)
    // e o paciente que a agenda acabou de casar com o cartão também (achado 8: sem buscar de novo pelo título)
    const doCartao = ctx.jornada === 'ligado' ? (idClientDoCartao(lead, ctx.camposPorNome ?? []) ?? (p.idsClient?.length === 1 ? p.idsClient[0] : null)) : null;
    const hist = historico ?? (await historicoDoPaciente(unit, p.idClient ?? doCartao ?? (await idClientDoLead(unit, leadId, p.nome))));
    if (hist) {
      const ids = new Set(agendamentos.map((s) => s.idSchedule));
      agendamentos = [...agendamentos, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))];
      if (hist.treatments.length > 0) tratamentos = hist.treatments;
    }
  }
  const regras1610 = ctx.jornada === 'ligado';
  const base: EntradaMovimento = { atual, agendamentos, tratamentos, agoraEpoch, horasAteNegociacao: horasAteNegociacao() };
  // 16/10 (achado 5 da revisão): as regras do ex-paciente precisam do histórico, que o cartão COMERCIAL não carregava.
  // Só quando faz diferença (`precisaHistoricoDoExPaciente`) e só com o paciente já conhecido: nenhuma busca nova.
  let entrada1610 = base;
  if (ctx.jornada && ctx.jornada !== 'desligado' && !precisaHistorico) {
    const semHistorico = planejarMovimento({ ...base, regras1610: true });
    if (precisaHistoricoDoExPaciente(base, semHistorico)) {
      const conhecido = p.idClient ?? (p.idsClient?.length === 1 ? p.idsClient[0] : null) ?? (regras1610 ? idClientDoCartao(lead, ctx.camposPorNome ?? []) : null);
      const hist = await historicoDoPaciente(unit, conhecido);
      if (hist) {
        const ids = new Set(agendamentos.map((s) => s.idSchedule));
        entrada1610 = { ...base, agendamentos: [...agendamentos, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))], tratamentos: hist.treatments.length > 0 ? hist.treatments : tratamentos };
      }
    }
  }
  const mov = planejarMovimento(regras1610 ? { ...entrada1610, regras1610: true } : { ...base, regras1610: false });
  // 16/10 em "só no papel": o robô move pela regra antiga e a tela mostra onde a regra nova levaria o cartão
  if (ctx.jornada === 'seco') {
    const novo = planejarMovimento({ ...entrada1610, regras1610: true });
    if (((novo?.para ?? null) !== (mov?.para ?? null) || (novo?.funil ?? null) !== (mov?.funil ?? null)) && !(novo && perdaTravada(unit, lead, novo.para, atual.status, AUTOMACAO_1610, agoraEpoch))) {
      registrarSimulacao(unit, AUTOMACAO_1610, { leadId, acao: 'moveria', alvo: novo ? novo.para : '(fica onde está)', deEtapa: atual.status, valor: novo?.semRegua ? 'sem régua' : undefined, motivo: novo?.motivo ?? `regras de 16/10: não move (a regra antiga leva pra ${mov?.para})` });
    }
  }
  // 16/10 (decisão 4): falta em retorno/sessão vira nota + tarefa, sem mexer na etapa
  await avisarFaltas(ctx, leadId, lead, atual.status, entrada1610.agendamentos).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: aviso de falta falhou'),
  );
  // 16/10 (achado 4 da revisão): tratamento FINALIZADO com sessão ainda marcada não move o cartão — vira UMA tarefa
  await avisarSujeira(ctx, leadId, lead, atual, entrada1610.agendamentos, entrada1610.tratamentos).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'casamento-jornada: aviso de sessão esquecida falhou'),
  );
  if (!mov) return;
  if (franquiaRespeitaEspera(unit, lead, atual, mov.para, agoraEpoch)) return; // EM ESPERA com ◷ Retomar em (auditoria 16/10, item 10)
  if (seco) {
    if (perdaTravada(unit, lead, mov.para, atual.status, ctx.automacaoDoSeco ?? 'franquia-revisao', agoraEpoch)) return;
    contarSimulado(resumo, atual.status, mov.para);
    logger.info({ unit: unit.slug, leadId, nome: lead.name, de: atual.status, para: mov.para, funil: mov.funil, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: mov.semRegua }, 'franquia-move [seco]: moveria');
    registrarSimulacao(unit, ctx.automacaoDoSeco ?? 'franquia-revisao', { leadId, acao: 'moveria', alvo: mov.para, deEtapa: atual.status, valor: mov.motivoPerda, motivo: mov.motivo });
    return;
  }
  // 16/10: saída de PERDIDO/ALTA porque a franquia manda — uma vez por fato
  if (regras1610 && mov.gatilho) {
    await franquiaMandaUmaVez(ctx, leadId, lead, atual, mov);
    return;
  }
  await aplicarMovimento(unit, kommo, funis, leadId, mov, resumo, atual.status, lead);
}

const REVISAO_MAX_POR_VARREDURA = Number(process.env.FRANQUIA_REVISAO_MAX) || 60;
/** teto de buscas na franquia por cartão: cada termo é uma chamada; 8 cobre dois nomes com sobrenome */
const MAX_TERMOS_DE_BUSCA = Number(process.env.FRANQUIA_MAX_TERMOS) || 10;

/**
 * Quais cartões a revisão pelo histórico olha (23/09/2026, pedido do João: "tem que puxar tudo certinho"):
 * - CONFERIR NA FRANQUIA: todos (achou o paciente? volta pra etapa certa; 30 d sem acerto → PERDIDO)
 * - AGENDADO com «◷ Data da Consulta» mais velha que D-3 ou vazia (a agenda D-3…D+45 nunca os vê)
 * - COMPARECEU / EM NEGOCIAÇÃO cuja Situação no cartão não é "Atendido" (a SDR moveu na mão, a franquia não confirmou)
 */
export function candidatoARevisao(etapa: string, valores: Record<string, string | null>, corteEpoch: number): boolean {
  const n = normalizarNome(etapa);
  const data = Number(valores[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
  if (n === normalizarNome(ETAPA.CONFERIR)) return true;
  if (n === normalizarNome(ETAPA.AGENDADO)) return !Number.isFinite(data) || data < corteEpoch;
  if (n === normalizarNome(ETAPA.COMPARECEU) || n === normalizarNome(ETAPA.NEGOCIACAO)) {
    return normalizar(valores[CAMPOS_SYNC.SITUACAO]) !== 'atendido' || !Number.isFinite(data);
  }
  return false;
}

function notaConferir(nome: string): string {
  return `🔎 A franquia não tem este paciente pelo nome «${nome.trim()}» nem pelo telefone do contato. Acerte o cadastro lá (nome e WhatsApp) ou o telefone aqui no cartão: corrigido, o cartão volta sozinho pra etapa certa em até 15 min. Sem acerto em ${JORNADA.CONFERIR_MAX_DIAS} dias vira PERDIDO ("${MOTIVO_PERDA.SEM_CADASTRO}").`;
}

/**
 * Caminho inverso: cartão → paciente (vínculo, nome sem a data da SDR, telefone) → histórico do
 * paciente (`GET /clients/{id}`, 1×/h) → mesma fase 1 e mesma máquina de etapas (jornada pela idade
 * do fato). Quem a franquia não conhece vai pra CONFERIR NA FRANQUIA (fila da SDR) e, 30 d depois sem
 * acerto, PERDIDO "sem cadastro". Erro da API da franquia não move nada (a busca lança).
 * Ex-paciente (tratamento finalizado, nada aberto) que aparece em etapa comercial: só registro — a ALTA
 * dispara templates de parabéns e não cabe meses depois.
 */
async function revisarPeloHistorico(ctxBase: CtxSync): Promise<void> {
  // A tela pode pôr ESTA unidade em seco sem mexer na variável global — por isso a pergunta vem
  // antes de montar o ctx, que é quem carrega o `seco` pro resto da revisão.
  const secoDaRevisao = estadoDaAutomacao(ctxBase.unit.slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS) === 'seco' || revisaoSeca();
  // o sincronizador inteiro em "Só no papel" segura a revisão também — senão ela gravaria com o resto em seco
  const seco = secoDaRevisao || ctxBase.seco === true;
  const ctx: CtxSync = { ...ctxBase, seco, automacaoDoSeco: secoDaRevisao ? 'franquia-revisao' : ctxBase.automacaoDoSeco };
  const { unit, kommo, funis, mapa, agoraEpoch, resumo } = ctx;
  if (!funis) return;
  if (!automacaoLigada(unit.slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS)) return;
  if (seco) logger.info({ unit: unit.slug }, 'franquia-move [seco]: revisão pelo histórico só registra, não mexe');
  const corte = agoraEpoch - DIAS_ATRAS * 86_400;
  const conferir = funis.idDe('COMERCIAL', ETAPA.CONFERIR);
  if (!conferir) logger.warn({ unit: unit.slug }, `franquia-move: conta sem a etapa "${ETAPA.CONFERIR}" — cartão sem paciente fica onde está`);
  let avaliados = 0;
  for (const etapa of [ETAPA.CONFERIR, ETAPA.AGENDADO, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO]) {
    const alvo = funis.idDe('COMERCIAL', etapa);
    if (!alvo) continue;
    const emConferir = etapa === ETAPA.CONFERIR;
    for (let page = 1; page <= 20; page++) {
      const leads = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true);
      if (leads.length === 0) break;
      for (const lead of leads) {
        if (!candidatoARevisao(etapa, valoresDoLead(lead, mapa), corte)) continue;
        // Kommo dividido: cartão de outra unidade, ou sem unidade, não é revisado por esta (nem gasta chamada)
        if (pularCartao(ctx.grupo ?? null, unit.id, lead, resumo)) continue;
        // 16/10: o `⚙ idClient` do cartão vem primeiro (decisão 3), e cartão travado em CONFLITO_FRANQUIA sem ele espera a SDR
        const jornada = ctx.jornada ?? 'desligado';
        const idDoCartao = idClientDoCartao(lead, ctx.camposPorNome ?? []);
        const travadoNoConflito = cartaoTravadoNoConflito(lead, idDoCartao, ctx.conflitosGuardados);
        if (jornada === 'ligado' && travadoNoConflito) continue;
        // já procurei este e não achei (cache 6 h): não gasta cota nem chamada; em CONFERIR ainda vale a regra dos 30 d
        const lembrado = cacheIdClient.get(`${unit.id}:${lead.id}`);
        const negativoLembrado = !!lembrado && lembrado.idClient === null && lembrado.expiraEm > Date.now() && !(jornada === 'ligado' && idDoCartao);
        if (negativoLembrado && !emConferir) continue;
        if (!negativoLembrado) {
          if (avaliados >= REVISAO_MAX_POR_VARREDURA) return;
          avaliados++;
        }
        try {
          const contatoId = lead._embedded?.contacts?.[0]?.id ?? null;
          let idClient: number | null;
          if (jornada === 'ligado') {
            const esc = negativoLembrado ? null : await casarPacienteDoCartao(unit, lead.id, lead.name ?? null, { kommo, contatoId, idDoCartao, campos: ctx.camposPorNome ?? [] });
            if (esc?.tipo === 'conflito') {
              // dois pacientes diferentes no mesmo telefone: não vai pra CONFERIR nem grava nada — a SDR escolhe no widget
              await marcarConflitoDeTelefone(ctx, lead.id, lead, esc.candidatos.map((c) => ({ idClient: c.idClient, nome: c.name })));
              continue;
            }
            idClient = !esc ? null : esc.tipo === 'achou' ? esc.idClient : esc.tipo === 'desempatar' ? await escolherEntreDuplicados(unit, esc.candidatos) : null;
            if (esc?.tipo === 'desempatar') {
              await avisarCadastroDuplicado(unit, kommo, lead.id, esc.candidatos.map((c) => c.idClient).filter((x): x is number => !!x), idClient, !!ctx.seco);
            }
            if (esc) cacheIdClient.set(`${unit.id}:${lead.id}`, { idClient, expiraEm: Date.now() + CACHE_LEAD_MS });
          } else {
            idClient = negativoLembrado ? null : await idClientDoLead(unit, lead.id, lead.name ?? null, { kommo, contatoId });
            if (jornada === 'seco' && !negativoLembrado) await simularCasamento(ctx, lead, idDoCartao, idClient, travadoNoConflito);
          }
          if (!idClient) {
            if (emConferir) {
              const parado = (agoraEpoch - (lead.updated_at ?? agoraEpoch)) / 86_400;
              // trava: cartão com consulta marcada PRA FRENTE nunca vira PERDIDO, mesmo sem paciente casado.
              // A fase 1 escreve essa data quando a franquia acha o paciente pelo telefone (caminho inverso do
              // nosso) — foi assim que dois cartões com consulta marcada foram fechados por engano em 23/09.
              const dataCartao = Number(valoresDoLead(lead, mapa)[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
              if (Number.isFinite(dataCartao) && dataCartao > agoraEpoch) {
                logger.info({ unit: unit.slug, leadId: lead.id, dataConsulta: dataCartao }, 'franquia-move: em CONFERIR mas com consulta marcada pra frente — não fecho');
                continue;
              }
              if (parado > JORNADA.CONFERIR_MAX_DIAS) {
                const mov: Movimento = { funil: 'COMERCIAL', para: ETAPA.PERDIDO, motivo: `${Math.floor(parado)} d em ${ETAPA.CONFERIR} sem acerto do cadastro`, motivoPerda: MOTIVO_PERDA.SEM_CADASTRO, semRegua: true, dias: Math.floor(parado) };
                if (seco) {
                  if (perdaTravada(unit, lead, mov.para, etapa, 'franquia-revisao', agoraEpoch)) continue;
                  contarSimulado(resumo, etapa, mov.para);
                  logger.info({ unit: unit.slug, leadId: lead.id, nome: lead.name, de: etapa, para: mov.para, motivo: mov.motivo }, 'franquia-move [seco]: moveria');
                  registrarSimulacao(unit, 'franquia-revisao', { leadId: lead.id, acao: 'moveria', alvo: mov.para, deEtapa: etapa, valor: mov.motivoPerda, motivo: mov.motivo });
                }
                else await aplicarMovimento(unit, kommo, funis, lead.id, mov, resumo, etapa, lead);
              }
              continue;
            }
            if (!conferir) continue;
            if (seco || estadoDoMove(unit.slug) === 'seco') {
              contarSimulado(resumo, etapa, ETAPA.CONFERIR);
              logger.info({ unit: unit.slug, leadId: lead.id, nome: lead.name, de: etapa, para: ETAPA.CONFERIR }, 'franquia-move [seco]: moveria');
              registrarSimulacao(unit, seco ? 'franquia-revisao' : 'franquia-move', { leadId: lead.id, acao: 'moveria', alvo: ETAPA.CONFERIR, deEtapa: etapa, motivo: 'paciente não achado na franquia' });
              continue;
            }
            await kommo.moveStage({ leadId: lead.id, statusId: conferir.statusId, pipelineId: conferir.pipelineId });
            resumo.movimentos++;
            await kommo.addLeadNote(lead.id, notaConferir(lead.name ?? '')).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'franquia-move: nota de CONFERIR falhou'));
            logger.info({ unit: unit.slug, leadId: lead.id, de: etapa, nome: lead.name }, `franquia-move: paciente não achado na franquia — cartão foi pra ${ETAPA.CONFERIR}`);
            await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
            continue;
          }
          if (await recusarOutroPaciente(ctx, lead.id, lead, [idClient])) continue;
          const hist = await historicoDoPaciente(unit, idClient);
          if (!hist) continue;
          // histórico inteiro: a máquina decide pela última avaliação e trata finalizado velho como ex-paciente (ALTA sem mensagem)
          if (hist.schedules.length === 0 && hist.treatments.length === 0) {
            logger.info({ unit: unit.slug, leadId: lead.id, idClient }, 'franquia-move: paciente achado, mas sem consulta nem tratamento no histórico — fica');
            continue;
          }
          if (hist.treatments.some(tratamentoFinalizado) && !hist.treatments.some(tratamentoAberto)) logger.info({ unit: unit.slug, leadId: lead.id, idClient, de: etapa }, 'franquia-move: ex-paciente (tratamento finalizado) em etapa comercial');
          resumo.revisados++;
          await processarCartao(ctx, lead.id, lead, { nome: lead.name ?? '', idClient, consultas: hist.schedules, tratamento: null }, hist);
        } catch (err) {
          resumo.erros++;
          logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, de: etapa }, 'franquia-move: falha na revisão pelo histórico');
        }
      }
      if (leads.length < 250) break;
    }
  }
}

/**
 * Os campos de lead da conta que o sincronizador pode escrever, indexados pelo nome normalizado.
 * Cabeçalho do agrupamento (`## ENDEREÇO`, `*TRATAMENTO*`) nunca é alvo: sai antes de qualquer casamento por nome.
 */
export function camposDaConta(camposBrutos: CampoBruto[]): CampoDaConta[] {
  return camposBrutos
    .filter((c) => !ehCabecalhoDeGrupo(c.name))
    .filter((c) => ['date', 'date_time', 'select', 'monetary', 'numeric', 'text', 'textarea', 'radiobutton'].includes(c.type))
    .map((c) => [normalizar(c.name), {
      id: c.id,
      nome: c.name,
      rawType: c.type,
      type: (c.type === 'date_time' ? 'date' : c.type) as KommoLeadCustomField['type'],
      enums: (c.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
    }]);
}

/** `deps.kommo` só existe para o teste falar com um Kommo falso; em produção o cliente nasce aqui. */
async function sincronizarUnidade(unit: Unit, deps: { kommo?: KommoClient } = {}): Promise<ResumoSync> {
  const resumo: ResumoSync = { unit: unit.slug, em: new Date().toISOString(), agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  // Kommo dividido (Caxias usa o de Petrópolis): o cliente do Kommo é o da DONA da conta; a franquia é a DESTA unidade.
  const grupo = await grupoDaUnidade(unit.id);
  const kommo = deps.kommo ?? createKommoClient(await contaDoKommo(unit));
  // "Só no papel" na tela de Automações: lê a franquia e registra o que gravaria, sem tocar no Kommo.
  const seco = estadoDaAutomacao(unit.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS) === 'seco';
  const bruto = (await kommo.listLeadCustomFields()) as { _embedded?: { custom_fields?: CampoBruto[] } } | undefined;
  const camposBrutos = bruto?._embedded?.custom_fields ?? [];
  const mapa = mapearCampos(camposBrutos);
  const camposPorNome = camposDaConta(camposBrutos);
  if (!mapa.DATA_CONSULTA || !mapa.SITUACAO) {
    logger.warn({ unit: unit.slug }, 'franquia-sync: conta sem os campos de consulta — pulando');
    return resumo;
  }
  const mover = estadoDoMove(unit.slug) !== 'desligado';
  const funis = mover ? await carregarFunis(kommo) : null;
  if (mover && !funis) logger.warn({ unit: unit.slug }, 'franquia-move: conta sem funil principal — só campos');
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const hoje = instanteNoFuso(new Date(), tz).slice(0, 10);
  const somar = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const [ag, tr] = await Promise.all([
    SpineService.searchSchedules(unit, { initialDate: somar(hoje, -DIAS_ATRAS), endDate: somar(hoje, DIAS_FRENTE), rowsPerPage: 100 }),
    SpineService.searchTreatments(unit),
  ]);
  const agendamentos: SpineSchedule[] = ag.ok ? (ag.data?.schedules ?? []) : [];
  const tratamentos: SpineTreatment[] = tr.ok ? (tr.data?.treatments ?? []) : [];
  if (!ag.ok) logger.warn({ unit: unit.slug, erro: ag.error }, 'franquia-sync: agenda indisponível');
  if (!tr.ok) logger.warn({ unit: unit.slug, erro: tr.error }, 'franquia-sync: tratamentos indisponíveis');
  resumo.agendamentos = agendamentos.length;
  resumo.tratamentos = tratamentos.length;

  // agrupa por paciente (a agenda não traz idClient; o nome é a chave)
  const porPaciente = new Map<string, { nome: string; idClient: number | null; consultas: SpineSchedule[]; tratamento: SpineTreatment | null }>();
  for (const s of agendamentos) {
    if (!s.clientName) continue;
    const k = normalizar(s.clientName);
    const p = porPaciente.get(k) ?? { nome: s.clientName, idClient: null, consultas: [], tratamento: null };
    p.consultas.push(s);
    porPaciente.set(k, p);
  }
  for (const t of tratamentos) {
    if (!t.clientName) continue;
    const k = normalizar(t.clientName);
    const p = porPaciente.get(k) ?? { nome: t.clientName, idClient: t.idClient, consultas: [], tratamento: null };
    p.tratamento = melhorTratamento(p.tratamento, t);
    p.idClient = p.idClient ?? t.idClient;
    porPaciente.set(k, p);
  }
  resumo.pacientes = porPaciente.size;
  const ops = opcoes(mapa);
  const agoraEpoch = Math.floor(Date.now() / 1000);
  // Chave `casamento-jornada` (regras de 16/10/2026): desligado = tudo como sempre.
  const jornada = estadoCasamentoJornada(unit.slug);
  const conflitosGuardados = jornada === 'ligado' ? await cartoesComConflitoGuardado(unit.id) : new Set<number>();
  const ctx: CtxSync = { unit, kommo, funis, mapa, ops, agoraEpoch, resumo, camposPorNome, tela: { sessao: null, aberta: false }, seco, automacaoDoSeco: seco ? 'franquia-sync' : undefined, grupo, jornada, conflitosGuardados, tocados: new Set() };

  // Casa TODOS os pacientes antes de gravar: só assim se vê o cartão que recebeu dois pacientes diferentes (mesmo
  // telefone) na mesma varredura — com a gravação no meio, o primeiro já teria escrito por cima (decisão 1, 16/10).
  type Casado = { p: (typeof porPaciente extends Map<string, infer V> ? V : never); casado: { leadId: number | null; idsClient: number[]; leadConfirmado: boolean } };
  const casados: Casado[] = [];
  let vistos = 0;
  for (const p of porPaciente.values()) {
    if (vistos++ >= MAX_PACIENTES_POR_VARREDURA) break;
    try {
      const idsSchedule = p.consultas.map((c) => c.idSchedule).filter((x): x is number => typeof x === 'number');
      casados.push({ p, casado: await resolverPaciente(unit, kommo, p.nome, p.idClient, idsSchedule) });
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, paciente: p.nome }, 'franquia-sync: falha no paciente');
    }
  }
  const variosNoCartao = jornada === 'desligado'
    ? new Map<number, string[]>()
    : cartoesComMaisDeUmPaciente(casados.map(({ p, casado }) => ({ leadId: casado.leadId, quem: identidadeDoPaciente(p.idClient, casado.idsClient, p.nome) })));

  const marcadosNestaVarredura = new Set<number>();
  for (const { p, casado } of casados) {
    try {
      const leadId = casado.leadId;
      if (!leadId) {
        resumo.semLead++;
        if (resumo.exemplosSemLead.length < 8) resumo.exemplosSemLead.push(p.nome);
        continue;
      }
      const lead = await kommo.getLead(leadId);
      // Kommo dividido: só o cartão desta unidade; campo vazio vai para a lista da SDR, sem atribuir. Vem ANTES do
      // conflito de paciente: cartão de outra unidade não é desta varredura nem para ganhar CONFLITO_FRANQUIA.
      const idsDoPaciente = p.idClient ? [p.idClient] : casado.idsClient;
      const idDoCartao = idClientDoCartao(lead, camposPorNome);
      if (pularCartao(grupo, unit.id, lead, resumo, { idsClient: idsDoPaciente, idDoCartao })) continue;
      resumo.comLead++;
      if (await recusarOutroPaciente(ctx, leadId, lead, idsDoPaciente)) continue;
      // 16/10 (decisão 1): cartão sem `⚙ idClient` que recebeu dois pacientes diferentes — ou que já está travado em
      // CONFLITO_FRANQUIA esperando a SDR — não recebe nada até ela escolher no widget. Com o ⚙ gravado, o filtro de
      // cima já deixa passar só o dono.
      if (jornada !== 'desligado' && idDoCartao === null) {
        const varios = variosNoCartao.has(leadId);
        // a marca no banco trava mesmo sem a etiqueta (Kommo fora na hora de etiquetar, ou alguém tirou à mão)
        const travado = cartaoTravadoNoConflito(lead, idDoCartao, conflitosGuardados);
        if (varios && !marcadosNestaVarredura.has(leadId)) {
          marcadosNestaVarredura.add(leadId);
          const pacientes = casados
            .filter((c) => c.casado.leadId === leadId)
            .map((c) => ({ idClient: c.p.idClient ?? c.casado.idsClient[0] ?? null, nome: c.p.nome }));
          await marcarConflitoDeTelefone(ctx, leadId, lead, pacientes);
        }
        if (jornada === 'ligado' && (varios || travado)) continue;
      }
      // 16/10: mesmo nome e mesmo telefone em mais de um cadastro da franquia — o robô segue (escolhe o de agenda mais
      // recente) e deixa UMA nota pedindo para juntar os cadastros
      if (jornada !== 'desligado' && !p.idClient && casado.idsClient.length > 1) {
        await avisarCadastroDuplicado(unit, kommo, leadId, casado.idsClient, null, jornada === 'seco' || seco);
      }
      // 16/10: cartão com dono (`⚙ idClient`) que recebeu mais de um paciente nesta varredura — quem não se sabe quem é
      // (veio só pelo nome da agenda, sem idClient) não grava: não dá para provar que é o dono, e o dono já foi escolhido.
      if (jornada === 'ligado' && idDoCartao !== null && idsDoPaciente.length === 0 && variosNoCartao.has(leadId)) {
        logger.info({ unit: unit.slug, leadId, idClientDoCartao: idDoCartao }, 'franquia-sync: paciente sem idClient num cartão com dono e mais de um paciente — não gravei');
        continue;
      }
      // Quem é este cartão na franquia, gravado de uma vez: a agenda provou agora, e sem o campo a
      // próxima varredura tem de adivinhar pelo nome. Só em cartão que ainda não tem dono, com UM
      // paciente, sem outro candidato nesta varredura e com o cartão CONFIRMADO pelo telefone —
      // gravar um palpite seria pior que não gravar, porque ninguém sobrescreve este campo depois:
      // o cartão da mãe estampado com o idClient da filha passaria a ser recusado para sempre.
      if (jornada !== 'desligado' && idDoCartao === null && idsDoPaciente.length === 1 && !variosNoCartao.has(leadId) && casado.leadConfirmado) {
        await gravarIdClientNoCartao(ctx, leadId, idsDoPaciente[0]);
      }
      await processarCartao(ctx, leadId, lead, { ...p, idsClient: idsDoPaciente });
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, paciente: p.nome }, 'franquia-sync: falha no paciente');
    }
  }

  // 16/10 (achado 7): a etiqueta CONFLITO_FRANQUIA sai quando o conflito some (ou a regra não está ligada)
  await faxinarConflitos(ctx, marcadosNestaVarredura).catch((err) => logger.warn({ err: String(err), unit: unit.slug }, 'casamento-jornada: faxina dos conflitos falhou'));

  if (funis) {
    try {
      await revisarPeloHistorico(ctx);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-move: falha na revisão pelo histórico');
    }
    try {
      await fecharSessoesDoTratamento(ctx);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-sessoes: falha no fechamento das sessões');
    }
    try {
      await passarNegociacao(unit, kommo, funis, mapa, resumo, { grupo, seco, campos: camposPorNome });
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-move: falha na passagem das 48 h');
    }
  }
  return resumo;
}

/** As unidades que o sincronizador atende agora — ligadas na tela e com credencial dos dois lados. */
async function unidadesDoSync(): Promise<Unit[]> {
  const units = await prisma.unit.findMany({ where: await ondeTemSync() });
  // "Só no papel" também varre (lê a franquia e registra) — só "desligado" fica de fora
  return units.filter((u) => estadoDaAutomacao(u.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS) !== 'desligado');
}

/**
 * Quem tem franquia e Kommo. A irmã de uma conta dividida (Caxias usa o Kommo de Petrópolis) não guarda
 * credencial de Kommo própria — de propósito, para nenhum worker antigo varrer a conta duas vezes — e entra pelo id.
 */
async function ondeTemSync() {
  const irmas = await irmasSemKommoProprio();
  return {
    spineEnabled: true,
    spineToken: { not: null },
    OR: [{ kommoAccessToken: { not: null } }, ...(irmas.length ? [{ id: { in: irmas } }] : [])],
  };
}

/**
 * Teto de varreduras ao mesmo tempo. Não é a trava velha disfarçada: aquela era 1 e valia para o
 * processo inteiro; esta existe só para não bater na franquia com N requisições paralelas quando
 * alguém ligar o sincronizador em vinte unidades de uma vez. Com o padrão em 6 — o número de
 * unidades ligadas hoje — ninguém espera.
 */
const MAX_PARALELO = Number(process.env.FRANQUIA_SYNC_PARALELO) || 6;
let rodandoAgora = 0;
const esperandoVaga: Array<() => void> = [];

async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (rodandoAgora >= MAX_PARALELO) {
    // Quem esperava NÃO incrementa ao acordar: o slot foi entregue já contado, no `finally` abaixo.
    await new Promise<void>((libera) => esperandoVaga.push(libera));
  } else {
    rodandoAgora++;
  }
  try {
    return await fn();
  } finally {
    // O slot passa DIRETO para quem espera, em vez de ser devolvido e retomado. Decrementar e só
    // depois acordar deixaria a vaga livre por um microtask, e um chamador novo — síncrono — a
    // tomaria antes de quem estava na fila; aí os dois entrariam e o teto seria furado por um.
    const proximo = esperandoVaga.shift();
    if (proximo) proximo();
    else rodandoAgora--;
  }
}

/** Varre UMA unidade. É aqui que a trava por unidade e o relógio dela se encontram. */
async function varrerUnidade(unit: Unit, forcada = false): Promise<void> {
  const desde = emVoo.get(unit.slug);
  if (desde !== undefined) {
    // LOGAR A BATIDA DESCARTADA. Antes isto era um `return` mudo, e o atraso era invisível: o ciclo
    // estourava e ninguém ficava sabendo até alguém reparar num cartão velho.
    logger.warn(
      { unit: unit.slug, haMin: Math.round((Date.now() - desde) / 60_000), forcada },
      'franquia-sync: batida descartada — esta unidade já está sendo varrida',
    );
    return;
  }
  emVoo.set(unit.slug, Date.now());
  const t0 = Date.now();
  try {
    const r = await sincronizarUnidade(unit);
    ultimoResumo.set(unit.slug, r);
    anotarVarredura(unit, r, Date.now() - t0);
    logger.info({ ...r, ms: Date.now() - t0 }, 'franquia-sync: varredura concluída');
  } catch (err) {
    logger.error({ err, unit: unit.slug }, 'franquia-sync: varredura falhou');
  } finally {
    // No finally, as duas: unidade que estourou não pode ficar travada para sempre, nem voltar
    // pro topo da fila a cada 15 min porque nunca registrou sucesso.
    anotarTentativa(unit.slug);
    emVoo.delete(unit.slug);
  }
}

/**
 * Varredura avulsa — o "forçar agora" da tela, e o caminho que o worker NÃO usa mais para a rotina.
 * Sem `soSlug` varre todas, agora em paralelo (respeitando `MAX_PARALELO`) em vez de uma de cada vez.
 */
async function varrer(soSlug?: string): Promise<void> {
  const fila = (await unidadesDoSync())
    .filter((u) => !soSlug || u.slug === soSlug)
    .sort((a, b) => ultimaTentativa(a.slug) - ultimaTentativa(b.slug));
  await Promise.all(fila.map((u) => comVaga(() => varrerUnidade(u, true))));
}

/**
 * Varredura fora de hora (João, 23/09/2026: "pode rodar agora pra consertar esses cartões, depois segue
 * de 15 em 15"). Dispara em segundo plano e responde na hora. O relógio de 15 min continua o mesmo.
 *
 * Forçar UMA unidade agora funciona mesmo com outra em voo — antes não funcionava, porque a trava
 * era global e o filtro de unidade vinha depois dela.
 */
export function varrerAgora(soSlug?: string): { iniciado: boolean; motivo?: string } {
  if (soSlug && emVoo.has(soSlug)) {
    const haMin = Math.round((Date.now() - (emVoo.get(soSlug) ?? Date.now())) / 60_000);
    return { iniciado: false, motivo: `${soSlug} já está sendo varrida há ${haMin} min` };
  }
  void varrer(soSlug).catch((err) => logger.error({ err, soSlug }, 'franquia-sync: varredura manual falhou'));
  return { iniciado: true };
}

/**
 * CADA UNIDADE COM SEU PRÓPRIO RELÓGIO (João, 29/09/2026: "vamos isolar para cada uma, não precisar
 * desse atraso global").
 *
 * Antes havia UM `setInterval` que, a cada 15 min, percorria todas as unidades com `await` — uma de
 * cada vez. Tirar a trava global (feito mais cedo hoje) consertou o "forçar agora", mas não isto:
 * com ~15 min por unidade e 6 unidades, a rotina continuava levando ~1h30 para dar a volta, e a
 * unidade no fim da fila via seus cartões 1h30 atrasados.
 *
 * Agora cada unidade tem um `setTimeout` próprio, que se reagenda 15 min DEPOIS de a varredura dela
 * terminar. O intervalo de uma não depende do tempo das outras, e unidade lenta atrasa só a si
 * mesma. Reagendar no fim — e não a cada 15 min fixos — é de propósito: se a varredura demorar 20
 * min, a próxima sai 15 min depois do fim, em vez de nascer já atrasada e empilhar.
 *
 * `MAX_PARALELO` é o único limite que sobrou, e existe para não bater na franquia com vinte
 * requisições ao mesmo tempo — não para serializar.
 */
const agendadas = new Map<string, NodeJS.Timeout | null>();
/** Quando o relógio de cada unidade dispara (epoch ms) — é o que a tela mostra como "próxima". */
const proximaEm = new Map<string, number>();
/** Espaçamento entre os primeiros disparos: vinte unidades não devem acordar no mesmo segundo. */
const ESCALONAR_MS = 20_000;
/** De quanto em quanto tempo o supervisor procura unidade nova (ou unidade que saiu). */
const RECONCILIAR_MS = 60_000;

function agendarUnidade(unit: Unit, emMs: number): void {
  proximaEm.set(unit.slug, Date.now() + emMs);
  agendadas.set(
    unit.slug,
    setTimeout(() => {
      agendadas.set(unit.slug, null); // gerenciada, mas sem timer: está rodando agora
      proximaEm.delete(unit.slug);
      void comVaga(() => varrerUnidade(unit)).finally(() => {
        // Só reagenda se ainda for gerenciada — `stop` e o supervisor apagam a entrada de quem saiu.
        if (agendadas.has(unit.slug)) agendarUnidade(unit, SWEEP_MS);
      });
    }, emMs),
  );
}

/** Liga o relógio de quem entrou e desliga o de quem saiu — é o que faz unidade nova começar sozinha. */
async function reconciliar(): Promise<void> {
  let units: Unit[];
  try {
    units = await unidadesDoSync();
  } catch (err) {
    logger.warn({ err: String(err) }, 'franquia-sync: não consegui reler as unidades — mantendo os relógios atuais');
    return;
  }
  const vivas = new Set(units.map((u) => u.slug));
  for (const [slug, t] of agendadas) {
    if (vivas.has(slug)) continue;
    if (t) clearTimeout(t);
    agendadas.delete(slug);
    proximaEm.delete(slug);
    logger.info({ unit: slug }, 'franquia-sync: unidade saiu do sincronizador — relógio desligado');
  }
  let novas = 0;
  for (const u of units) {
    if (agendadas.has(u.slug)) continue;
    agendarUnidade(u, PRIMEIRA_MS + novas * ESCALONAR_MS);
    novas++;
  }
  if (novas) logger.info({ novas, total: agendadas.size }, 'franquia-sync: relógios ligados');
}

export function startFranquiaSyncWorker(): void {
  if (timer) return;
  void reconciliar();
  timer = setInterval(() => void reconciliar(), RECONCILIAR_MS);
  logger.info(
    {
      slugs: process.env.FRANQUIA_SYNC_SLUGS ?? '(vazio = desligado)',
      intervaloMin: SWEEP_MS / 60_000,
      maxParalelo: MAX_PARALELO,
    },
    'franquia-sync: worker iniciado — um relógio por unidade',
  );
}

export function stopFranquiaSyncWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
  // Os relógios por unidade também: sem isto, parar o worker deixaria N timeouts vivos segurando o
  // processo no deploy, e o `finally` de cada um reagendaria o próximo.
  for (const t of agendadas.values()) if (t) clearTimeout(t);
  agendadas.clear();
  proximaEm.clear();
}

export const _interno = { mapearCampos, valoresDoLead, procurarPaciente, espelharPaciente, recusarOutroPaciente, resolverPaciente, marcarConflitoDeTelefone, avisarFaltas, processarCartao, sincronizarUnidade, revisarPeloHistorico, gravarIdClientNoCartao, fecharSessoesDoTratamento };
