/**
 * Renomeia o lead novo de Petrópolis e Caxias. Regras em `renomear-lead.ts`.
 *
 * POR QUE É UM WORKER E NÃO UM GANCHO DO WEBHOOK: o Kommo dessa conta não manda mensagem para o agente (0
 * execution_traces em 7 dias) — e não se registra webhook de mensagem lá, porque a Sofia passaria a responder. O
 * `titulo-padrao` (que roda no webhook) nunca acordaria. Então a cada 5 minutos, por CONTA do Kommo, o robô lê os
 * leads criados nas últimas 24 h que ainda têm o nome do Kommo ("Lead #123") e têm pelo menos 3 minutos de vida.
 *
 * Quem decide, cartão a cartão, é a chave `renomear-lead` na tela de Automações, da unidade do cartão (⌂ Unidade de
 * atendimento); cartão sem unidade vale a mais fraca das chaves da conta (ver `estadoDoCartao`). Desligado não faz
 * nada; "só no papel" registra "renomearia X → Y" no log e na lista "o que ela faria"; ligado grava. Nenhuma unidade é
 * citada no código: vale em qualquer conta cuja unidade tenha a chave ligada.
 *
 * Gravação: PATCH só do nome, depois de reler o lead (a SDR pode ter nomeado no meio da varredura). No máximo 50 por
 * rodada. Sobre o `titulo-padrao` (webhook de mensagem, que nessas contas nunca acorda): ele escreve "Lead
 * dd/mm/aaaa" e este robô "Lead dd/mm/aa" — nenhum dos dois reescreve o título do outro (não é "sem nome"), mas cada um
 * numera só os do seu formato. Não ligue os dois na mesma unidade. E o `ehTituloPadrao` (que deixa a captura de nome da
 * Sofia trocar o provisório) só reconhece o de 4 dígitos: se a Sofia um dia atender Petrópolis, ele precisa aprender o de 2.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDoKommo, grupoDaUnidade, valorDaUnidadeNoCartao, type MembroDoCrm } from './crm-compartilhado.js';
import { fusoDaUnidade } from './fuso.js';
import { dataCurta, ehSemNome, estadoDoCartao, planejarRenomeacao, type EstadoDaChave } from './renomear-lead.js';

const ID = 'renomear-lead';
const ALVO = 'Nome do cartão';
const SWEEP_MS = 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
/** Só leads que nasceram nas últimas 24 h: o estoque antigo é das SDRs, não deste robô. */
const JANELA_S = 24 * 3600;
/**
 * Lê 50 h para a numeração ("Lead 2 …") enxergar o dia local inteiro de um lead criado 24 h atrás: o dia dele começou
 * no máximo 24 h antes (24 + 24 = 48 h) — as 2 h de folga são margem. Só entram na conta os do MESMO dd/mm/aa local.
 */
const LEITURA_S = 50 * 3600;
/** Dá tempo da SDR nomear sozinha e do contato ganhar o nome do perfil do WhatsApp. */
const IDADE_MINIMA_S = 3 * 60;
const MAX_PAGINAS = 8;
const MAX_GRAVACOES_POR_RODADA = 50;
const FALHAS_SEGUIDAS_PARA_PARAR = 3;
/** Contato que ainda não veio na leitura depois de tanto tempo é contato apagado/mesclado. */
const CONTATO_AUSENTE_DESISTE_S = 30 * 60;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
/** Leads já anunciados em seco neste processo (o log não repete a cada 5 min; a tela já deduplica). */
const anunciados = new Set<number>();

const estadoDe = (slug: string): EstadoDaChave => estadoDaAutomacao(slug, ID, process.env.RENOMEAR_LEAD_SLUGS);

function contatoPrincipal(lead: KommoLead): number | null {
  const contatos = lead._embedded?.contacts ?? [];
  return (contatos.find((c) => c.is_main) ?? contatos[0])?.id ?? null;
}

export interface Resumo {
  candidatos: number;
  gravados: number;
  simulados: number;
  desligados: number;
  jaNomeados: number;
  semContato: number;
  erros: number;
}

/** O que o robô precisa do Kommo — o `KommoClient` de verdade serve; o teste entrega um falso. */
export type KommoDoRenomear = Pick<KommoClient, 'listLeadsNaJanela' | 'contatosBasicos' | 'getLead' | 'updateLeadName'>;

export interface ContextoDaConta {
  unit: Pick<Unit, 'id' | 'slug' | 'businessHoursTimezone' | 'spineTimezone'>;
  membros: ReadonlyArray<MembroDoCrm> | null;
  kommo: KommoDoRenomear;
  estadoDe: (slug: string) => EstadoDaChave;
  /** epoch em segundos */
  agora: number;
  registrar?: typeof registrarSimulacao;
}

/** Alguma unidade da conta (ela mesma, ou o grupo Petrópolis + Caxias) está em seco ou ligada? */
function algumaChaveAtiva(unit: { slug: string }, membros: ReadonlyArray<MembroDoCrm> | null, estado: (slug: string) => EstadoDaChave): boolean {
  const slugs = membros?.length ? membros.map((m) => m.slug).filter((s): s is string => !!s) : [unit.slug];
  return slugs.some((s) => estado(s) !== 'desligado');
}

/** Uma rodada numa conta do Kommo. Devolve o resumo (ou `null` se não havia nada a fazer). */
export async function renomearConta(ctx: ContextoDaConta): Promise<Resumo | null> {
  const { unit, membros, kommo, estadoDe: estado, agora } = ctx;
  const registrar = ctx.registrar ?? registrarSimulacao;
  if (!algumaChaveAtiva(unit, membros, estado)) return null;

  const { leads, truncado } = await kommo.listLeadsNaJanela('created_at', agora - LEITURA_S, agora, MAX_PAGINAS, true);
  // lista cortada = numeração do dia errada: melhor não fazer nada do que repetir "Lead 2"
  if (truncado) {
    logger.warn({ unit: unit.slug, leads: leads.length }, `${ID}: a lista de leads recentes veio cortada — não renomeei nada nesta rodada`);
    return null;
  }

  const tz = fusoDaUnidade(unit);
  const candidatos = leads
    .filter((l) => ehSemNome(l.name) && (l.created_at ?? 0) >= agora - JANELA_S && (l.created_at ?? 0) <= agora - IDADE_MINIMA_S)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id);
  if (!candidatos.length) return null;

  // o NOME DO CONTATO (perfil do WhatsApp) é o que as SDRs copiam. Se a leitura falhar, lança: não degrada para "Lead".
  const contatos = await kommo.contatosBasicos(candidatos.map(contatoPrincipal).filter((n): n is number => n !== null));

  const resumo: Resumo = { candidatos: candidatos.length, gravados: 0, simulados: 0, desligados: 0, jaNomeados: 0, semContato: 0, erros: 0 };
  // nomes de todos os leads da janela, por dia: a numeração enxerga o que as SDRs já puseram e o que este robô já planejou
  const nomes = new Map<number, string>(leads.map((l) => [l.id, l.name ?? '']));
  const diaDe = new Map<number, string>(leads.map((l) => [l.id, dataCurta(l.created_at ?? 0, tz)]));
  let falhasSeguidas = 0;
  let tentativas = 0;

  for (const lead of candidatos) {
    // o teto conta só as gravações de verdade (seco, unidade desligada e contato não lido não gastam vaga)
    if (tentativas >= MAX_GRAVACOES_POR_RODADA) break;
    const { dono, estado: estadoDoLead } = estadoDoCartao(membros, estado, valorDaUnidadeNoCartao(lead), unit);
    if (estadoDoLead === 'desligado') {
      resumo.desligados++;
      continue;
    }
    const cid = contatoPrincipal(lead);
    // contato que não veio na leitura: pode ser instabilidade do Kommo — tenta na próxima rodada. Passada meia hora é
    // contato apagado ou mesclado, que nunca vai vir: o lead vira "Lead dd/mm/aa" em vez de ficar "Lead #123" para sempre.
    const contatoAusente = cid !== null && !contatos.has(cid);
    if (contatoAusente && (lead.created_at ?? 0) > agora - CONTATO_AUSENTE_DESISTE_S) {
      resumo.semContato++;
      continue;
    }
    if (contatoAusente) logger.warn({ unit: unit.slug, leadId: lead.id, contatoId: cid }, `${ID}: o contato do lead não existe mais — uso "Lead dd/mm/aa"`);
    const data = diaDe.get(lead.id) ?? dataCurta(lead.created_at ?? agora, tz);
    const doDia = leads.filter((l) => l.id !== lead.id && diaDe.get(l.id) === data).map((l) => nomes.get(l.id) ?? '');
    const plano = planejarRenomeacao({
      nomeDoLead: lead.name,
      nomeDoContato: cid !== null ? (contatos.get(cid)?.nome ?? null) : null,
      data,
      nomesDoDia: doDia,
    });
    if (!plano) continue;
    const quem = dono ?? { id: unit.id, slug: unit.slug };

    if (estadoDoLead === 'seco') {
      resumo.simulados++;
      nomes.set(lead.id, plano.para);
      registrar(quem, ID, { leadId: lead.id, acao: 'gravaria', alvo: ALVO, valor: plano.para, noCartao: lead.name, motivo: plano.motivo });
      if (!anunciados.has(lead.id)) {
        anunciados.add(lead.id);
        if (anunciados.size > 5000) anunciados.clear();
        logger.info({ unit: quem.slug, leadId: lead.id, de: lead.name, para: plano.para, tipo: plano.tipo, motivo: plano.motivo }, `${ID} [seco]: renomearia "${lead.name}" → "${plano.para}"`);
      }
      continue;
    }

    tentativas++;
    try {
      // a SDR pode ter nomeado enquanto líamos os contatos: relê antes de gravar
      const atual = await kommo.getLead(lead.id);
      if (!ehSemNome(atual.name) || (atual.name ?? '').trim() !== (lead.name ?? '').trim()) {
        resumo.jaNomeados++;
        logger.info({ unit: quem.slug, leadId: lead.id, nome: atual.name }, `${ID}: o nome chegou antes — não sobrescrevo`);
        continue;
      }
      await kommo.updateLeadName(lead.id, plano.para);
      nomes.set(lead.id, plano.para);
      resumo.gravados++;
      falhasSeguidas = 0;
      logger.info({ unit: quem.slug, leadId: lead.id, de: lead.name, para: plano.para, tipo: plano.tipo, motivo: plano.motivo }, `${ID}: lead renomeado`);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: quem.slug, leadId: lead.id }, `${ID}: falha ao renomear`);
      if (++falhasSeguidas >= FALHAS_SEGUIDAS_PARA_PARAR) {
        logger.warn({ unit: unit.slug }, `${ID}: ${FALHAS_SEGUIDAS_PARA_PARAR} falhas seguidas — paro esta rodada`);
        break;
      }
    }
  }
  logger.info({ conta: unit.slug, ...resumo }, `${ID}: varredura`);
  return resumo;
}

async function varrerConta(daConta: Unit): Promise<void> {
  // Kommo dividido: quem tem as credenciais, o fuso e o rótulo-base é a unidade DONA da conta, não a primeira que apareceu
  const unit = (await contaDoKommo(daConta)) as Unit;
  if (!unit.kommoAccessToken) return;
  const grupo = await grupoDaUnidade(unit.id);
  const membros = grupo?.membros ?? null;
  // olha as chaves ANTES de abrir o cliente do Kommo: conta com tudo desligado não custa nada
  if (!algumaChaveAtiva(unit, membros, estadoDe)) return;
  await renomearConta({ unit, membros, kommo: createKommoClient(unit), estadoDe, agora: Math.floor(Date.now() / 1000) });
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
    // Uma varredura por CONTA do Kommo (a dona tem as credenciais; a irmã, Caxias, não tem e entra pelo grupo).
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

export function startRenomearLeadWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID}: worker iniciado`);
}

export function stopRenomearLeadWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
