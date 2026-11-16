/**
 * Renomeia o lead novo de Petrópolis e Caxias. Regras em `renomear-lead.ts`.
 *
 * POR QUE É UM WORKER E NÃO UM GANCHO DO WEBHOOK: o Kommo dessa conta não manda mensagem para o agente (0
 * execution_traces em 7 dias) — e não se registra webhook de mensagem lá, porque a Sofia passaria a responder. O
 * `titulo-padrao` (que roda no webhook) nunca acordaria. Então a cada 5 minutos, por CONTA do Kommo, o robô lê os
 * leads criados nas últimas 24 h que ainda têm título genérico ("Lead #123" do Kommo ou o provisório do
 * `titulo-padrao`) e têm pelo menos 3 minutos de vida.
 *
 * Quem decide, cartão a cartão, é a chave `renomear-lead` na tela de Automações, da unidade do cartão (⌂ Unidade de
 * atendimento); cartão sem unidade vale a mais fraca das chaves da conta (ver `estadoDoCartao`). Desligado não faz
 * nada; "só no papel" registra "renomearia X → Y (fonte)" no log e na lista "o que ela faria"; ligado grava. Nenhuma
 * unidade é citada no código: vale em qualquer conta cuja unidade tenha a chave ligada.
 *
 * O NOME vem da franquia (paciente achado pelo telefone, quando é um só) e, na falta, do contato do WhatsApp. Nada
 * serviu: "Lead #123" vira "Lead dd/mm/aa"; um título genérico que já estava lá FICA (nunca genérico por genérico).
 *
 * ESTOQUE (16/11/2026): `RENOMEAR_LEAD_DESDE` = `slug=AAAA-MM-DD` alcança os cartões ABERTOS criados desde esse dia (no fuso da
 * unidade); sem a entrada vale só a janela de 24 h, como sempre. O estoque anda devagar: no máximo 15 gravações por
 * rodada, com pausa entre elas, e no máximo 25 consultas novas à franquia — a conta do Kommo é dividida com o atendimento
 * da Sofia, então nada de rajada.
 *
 * Gravação: PATCH só do nome, depois de reler o lead (a SDR pode ter nomeado no meio da varredura). No máximo 50 por
 * rodada. Sobre o `titulo-padrao` (webhook de mensagem): ele só escreve em lead "sem nome" do Kommo e este robô só troca
 * título genérico por NOME — nenhum reescreve o título do outro em círculo. Pode ligar os dois na mesma unidade; o
 * renomear corrige depois o genérico que o `titulo-padrao` pôs. O `ehTituloPadrao` (que deixa a captura de nome da Sofia
 * trocar o provisório) só reconhece o de 4 dígitos: o "Lead dd/mm/aa" nosso a Sofia não troca, mas este robô sim, quando o
 * contato ganha nome.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDoKommo, grupoDaUnidade, valorDaUnidadeNoCartao, type MembroDoCrm } from './crm-compartilhado.js';
import { algumaChaveAtiva, contatoPrincipal } from './kommo-lead-util.js';
import { fusoDaUnidade } from './fuso.js';
import { agendarIndice, chaveDoTelefone, consultarIndice } from './franquia-indice-telefones.js';
import {
  dataCurta,
  desdeDaUnidade,
  ehSemNome,
  ehTituloGenerico,
  estadoDoCartao,
  nomeDeGente,
  planejarRenomeacao,
  type EstadoDaChave,
  type NomesNaFranquia,
} from './renomear-lead.js';

const ID = 'renomear-lead';
const ALVO = 'Nome do cartão';
const SWEEP_MS = 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
/** Sem a janela por unidade, só leads que nasceram nas últimas 24 h: o estoque antigo é das SDRs, não deste robô. */
const JANELA_S = 24 * 3600;
/**
 * Lê 26 h além do começo da janela para a numeração ("Lead 2 …") enxergar o dia local inteiro do lead mais velho: o dia dele
 * começou no máximo 24 h antes — as 2 h de folga são margem. Só entram na conta os do MESMO dd/mm/aa local.
 */
const FOLGA_LEITURA_S = 26 * 3600;
/** Dá tempo da SDR nomear sozinha e do contato ganhar o nome do perfil do WhatsApp. */
const IDADE_MINIMA_S = 3 * 60;
/**
 * O título provisório do `titulo-padrao` ("Lead dd/mm/aaaa") é o que a Sofia troca quando o paciente diz o nome: onde ela atende, a
 * captura dela tem meia hora de vantagem antes de este robô pôr o nome do perfil do WhatsApp (a rede de segurança dela não
 * sobrescreve nome já posto).
 */
const IDADE_MINIMA_PROVISORIO_S = 30 * 60;
const MAX_PAGINAS = 8;
const MAX_GRAVACOES_POR_RODADA = 50;
/** O estoque (mais de 24 h) anda devagar: a conta do Kommo é dividida com a Sofia. */
const MAX_GRAVACOES_ESTOQUE_POR_RODADA = 15;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
/** Consultas NOVAS à franquia por rodada (a resposta fica guardada no processo). */
const MAX_CONSULTAS_FRANQUIA_POR_RODADA = 25;
const FRANQUIA_VALE_MS = 6 * 3600_000;
const FRANQUIA_INDISPONIVEL_VALE_MS = 10 * 60_000;
/** A consulta à franquia (índice + ficha) não segura a rodada: as consultas são em fila, uma por vez. */
const TIMEOUT_FRANQUIA_MS = 5000;
function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`franquia sem resposta em ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
const FALHAS_SEGUIDAS_PARA_PARAR = 3;
/** Contato que ainda não veio na leitura depois de tanto tempo é contato apagado/mesclado. */
const CONTATO_AUSENTE_DESISTE_S = 30 * 60;
/** Fechado no Kommo: ganho (142) ou perdido (143). O estoque só alcança cartão ABERTO. */
const FECHADOS = new Set([142, 143]);

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
/** Leads já anunciados em seco neste processo (o log não repete a cada 5 min; a tela já deduplica). */
const anunciados = new Set<number>();
const anunciadosSemNome = new Set<number>();
/** Cartão genérico em que nenhuma fonte deu nome: só olho de novo depois disto (o contato pode ganhar o nome do perfil). */
const REVER_SEM_NOME_MS = 60 * 60_000;
const semNomeAte = new Map<number, number>();
/** Conta cuja janela larga do estoque estourou o teto de leitura: até quando só as 24 h (por unidade dona da conta). */
const leituraLargaEstourouAte = new Map<string, number>();
/** Cartões que esperaram a franquia responder: depois de tantas rodadas segue sem ela (a franquia só completa o sobrenome). */
const esperasDaFranquia = new Map<number, number>();
const MAX_ESPERAS_DA_FRANQUIA = 6;
const avisados = new Set<string>();
function avisarUmaVez(chave: string, msg: string): void {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  logger.warn(`${ID}: ${msg}`);
}
/** O que a franquia respondeu por (unidade, telefone) — só respostas conclusivas; `indisponivel` tenta de novo na rodada seguinte. */
const franquiaEmCache = new Map<string, { ate: number; valor: NomesNaFranquia }>();

/** Só para teste. */
export function _limparParaTeste(): void {
  anunciados.clear();
  anunciadosSemNome.clear();
  semNomeAte.clear();
  leituraLargaEstourouAte.clear();
  esperasDaFranquia.clear();
  avisados.clear();
  franquiaEmCache.clear();
}

const estadoDe = (slug: string): EstadoDaChave => estadoDaAutomacao(slug, ID, process.env.RENOMEAR_LEAD_SLUGS);

export interface Resumo {
  candidatos: number;
  gravados: number;
  simulados: number;
  desligados: number;
  jaNomeados: number;
  semContato: number;
  /** título genérico em que nenhuma fonte deu nome: fica como está */
  semNomeParaDar: number;
  /** esperando a franquia responder / a vez na fila de consultas */
  adiados: number;
  /** cartão genérico mais velho que a janela da sua unidade (ou fechado, no estoque) */
  foraDaJanela: number;
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
  /**
   * O paciente da franquia deste telefone. Omitido = não consulta a franquia (só o nome do contato). Lançar = `indisponivel`.
   * Só é chamado para cartão de unidade conhecida (nunca para cartão sem unidade numa conta dividida).
   */
  franquia?: (quem: { id: string; slug: string }, telefone: string | null) => Promise<NomesNaFranquia>;
  /** Pede a carga do índice de telefones da franquia desta unidade, se for hora (idempotente, em segundo plano). Só para unidade com a chave em seco ou ligada. */
  garantirIndice?: (quem: { id: string; slug: string }) => void;
  /** `RENOMEAR_LEAD_DESDE` (o teste passa o valor; produção lê do ambiente) */
  desde?: string;
  /** pausa entre gravações do estoque (o teste zera) */
  pausaMs?: number;
}

/**
 * A franquia de verdade: índice de telefones (nosso banco) → ficha do paciente (o nome). Não pergunta à franquia por telefone:
 * ela ignora o filtro. O índice guarda UM paciente por telefone, então "mais de um" não aparece aqui — quem protege a mãe
 * escrevendo pela filha é a conferência com o nome do contato em `escolherNome`.
 */
export async function nomesNaFranquiaPadrao(quem: { id: string; slug: string }, telefone: string | null): Promise<NomesNaFranquia> {
  const chave = chaveDoTelefone(telefone);
  if (!chave) return { tipo: 'nenhum' };
  const unit = await prisma.unit.findUnique({ where: { id: quem.id } });
  if (!unit?.spineEnabled || !unit.spineToken) return { tipo: 'nenhum' };
  const ind = await consultarIndice(unit.id, chave);
  const pacientes = ind.entradas.filter((e) => e.origem === 'paciente' && e.id);
  if (pacientes.length === 0) {
    // índice que nunca foi montado ou está velho não prova "não está na franquia"
    return ind.entradas.length > 0 || ind.fresco ? { tipo: 'nenhum' } : { tipo: 'indisponivel', motivo: 'o índice de telefones da franquia ainda não está pronto' };
  }
  const nomes: string[] = [];
  for (const p of pacientes) {
    const r = await SpineService.getClient(unit, p.id as number);
    if (!r.ok || !r.data?.client) return { tipo: 'indisponivel', motivo: 'a ficha do paciente não veio' };
    const ficha = r.data.client;
    // o id do índice tem de ser mesmo desse telefone (a ficha traz o WhatsApp)
    const dela = chaveDoTelefone(ficha.whatsapp);
    if (dela && dela !== chave) continue;
    if (ficha.name) nomes.push(ficha.name);
  }
  return nomes.length ? { tipo: 'pacientes', nomes } : { tipo: 'nenhum' };
}

/** Pede a carga do índice (1×/dia por unidade, em segundo plano). Nunca lança. */
function garantirIndicePadrao(quem: { id: string; slug: string }): void {
  void prisma.unit
    .findUnique({ where: { id: quem.id } })
    .then((u) => { if (u) agendarIndice(u); })
    .catch((err) => logger.warn({ err: String(err), unit: quem.slug }, `${ID}: não consegui pedir o índice da franquia`));
}

/** Uma rodada numa conta do Kommo. Devolve o resumo (ou `null` se não havia nada a fazer). */
export async function renomearConta(ctx: ContextoDaConta): Promise<Resumo | null> {
  const { unit, membros, kommo, estadoDe: estado, agora } = ctx;
  const registrar = ctx.registrar ?? registrarSimulacao;
  if (!algumaChaveAtiva(unit, membros, estado)) return null;
  const rawDesde = ctx.desde ?? process.env.RENOMEAR_LEAD_DESDE;
  const tz = fusoDaUnidade(unit);
  // o índice de telefones da franquia leva minutos para montar: pede já (só para quem tem a chave em seco ou ligada)
  if (ctx.garantirIndice) {
    const quemTemChave = membros?.length ? membros.filter((m) => m.slug && estado(m.slug) !== 'desligado').map((m) => ({ id: m.unitId, slug: m.slug as string })) : [{ id: unit.id, slug: unit.slug }];
    for (const q of quemTemChave) ctx.garantirIndice(q);
  }

  // De que instante em diante o cartão desta unidade é alcançado: 24 h, ou o dia pedido em RENOMEAR_LEAD_DESDE se for mais antigo.
  const slugsAtivos = (membros?.length ? membros.map((m) => m.slug).filter((s): s is string => !!s) : [unit.slug]).filter((s) => estado(s) !== 'desligado');
  // Pedido de estoque que não vale (data velha demais, no futuro, inexistente): avisa uma vez, senão parece que o robô travou.
  for (const s of slugsAtivos) {
    if ((rawDesde ?? '').replace(/^['"]|['"]$/g, '').split(',').some((p) => p.split('=')[0].trim() === s) && desdeDaUnidade(s, rawDesde, tz, agora) === null) {
      avisarUmaVez(`${s}|${rawDesde}`, `RENOMEAR_LEAD_DESDE de ${s} não vale (precisa ser AAAA-MM-DD, existir, não estar no futuro e ter até 30 dias) — só as últimas 24 h`);
    }
  }
  let soRecentes = (leituraLargaEstourouAte.get(unit.id) ?? 0) > agora * 1000;
  const inicios = new Map<string, number>();
  const inicioDa = (slug: string): number => {
    if (soRecentes) return agora - JANELA_S;
    let v = inicios.get(slug);
    if (v === undefined) {
      v = Math.min(agora - JANELA_S, desdeDaUnidade(slug, rawDesde, tz, agora) ?? Infinity);
      inicios.set(slug, v);
    }
    return v;
  };
  const inicioDaLeitura = () => Math.min(agora - JANELA_S, ...slugsAtivos.map(inicioDa));

  let inicioLeitura = inicioDaLeitura();
  let { leads, truncado } = await kommo.listLeadsNaJanela('created_at', inicioLeitura - FOLGA_LEITURA_S, agora, MAX_PAGINAS, true);
  // A janela do estoque alargou a leitura e estourou o teto de páginas: o estoque não pode derrubar o caminho normal. Volta às 24 h
  // (e lembra por uma hora, para não reler 8 páginas à toa a cada 5 minutos).
  if (truncado && inicioLeitura < agora - JANELA_S) {
    logger.warn({ unit: unit.slug, leads: leads.length }, `${ID}: a janela do estoque (RENOMEAR_LEAD_DESDE) estourou o teto de leitura — só as últimas 24 h pela próxima hora`);
    leituraLargaEstourouAte.set(unit.id, agora * 1000 + REVER_SEM_NOME_MS);
    soRecentes = true;
    inicioLeitura = inicioDaLeitura();
    ({ leads, truncado } = await kommo.listLeadsNaJanela('created_at', inicioLeitura - FOLGA_LEITURA_S, agora, MAX_PAGINAS, true));
  }
  // lista cortada = numeração do dia errada: melhor não fazer nada do que repetir "Lead 2"
  if (truncado) {
    logger.warn({ unit: unit.slug, leads: leads.length }, `${ID}: a lista de leads recentes veio cortada — não renomeei nada nesta rodada`);
    return null;
  }

  const candidatos = leads
    .filter((l) => ehTituloGenerico(l.name) && (l.created_at ?? 0) >= inicioLeitura && (l.created_at ?? 0) <= agora - (ehSemNome(l.name) ? IDADE_MINIMA_S : IDADE_MINIMA_PROVISORIO_S))
    // os de hoje primeiro: o estoque nunca toma a vez (nem as consultas à franquia) de quem acabou de chegar
    .sort((a, b) => Number((a.created_at ?? 0) < agora - JANELA_S) - Number((b.created_at ?? 0) < agora - JANELA_S) || (a.created_at ?? 0) - (b.created_at ?? 0) || a.id - b.id);
  if (!candidatos.length) return null;

  const resumo: Resumo = { candidatos: candidatos.length, gravados: 0, simulados: 0, desligados: 0, jaNomeados: 0, semContato: 0, semNomeParaDar: 0, adiados: 0, foraDaJanela: 0, erros: 0 };

  // Primeira passada, sem custo: de quem é o cartão, a chave vale, está dentro da janela da unidade e (estoque) está aberto.
  const alvos: Array<{ lead: KommoLead; dono: { id: string; slug: string } | null; estadoDoLead: EstadoDaChave; estoque: boolean }> = [];
  for (const lead of candidatos) {
    const { dono, estado: estadoDoLead } = estadoDoCartao(membros, estado, valorDaUnidadeNoCartao(lead), unit);
    if (estadoDoLead === 'desligado') {
      resumo.desligados++;
      continue;
    }
    // já vi que nenhuma fonte dá nome a este: não gasta contato nem franquia de novo por uma hora
    if ((semNomeAte.get(lead.id) ?? 0) > agora * 1000) {
      resumo.semNomeParaDar++;
      continue;
    }
    // cartão sem unidade numa conta dividida: vale a janela mais curta das unidades (a data de início mais nova)
    const inicio = dono ? inicioDa(dono.slug) : Math.max(...slugsAtivos.map(inicioDa));
    const estoque = (lead.created_at ?? 0) < agora - JANELA_S;
    if ((lead.created_at ?? 0) < inicio || (estoque && FECHADOS.has(lead.status_id))) {
      resumo.foraDaJanela++;
      continue;
    }
    alvos.push({ lead, dono, estadoDoLead, estoque });
  }
  if (!alvos.length) return resumo;

  // o NOME DO CONTATO (perfil do WhatsApp) é o que as SDRs copiam. Se a leitura falhar, lança: não degrada para "Lead".
  const contatos = await kommo.contatosBasicos(alvos.map((a) => contatoPrincipal(a.lead)).filter((n): n is number => n !== null));
  // nomes de todos os leads da janela, por dia: a numeração enxerga o que as SDRs já puseram e o que este robô já planejou
  const nomes = new Map<number, string>(leads.map((l) => [l.id, l.name ?? '']));
  const diaDe = new Map<number, string>(leads.map((l) => [l.id, dataCurta(l.created_at ?? 0, tz)]));
  const idsDoDia = new Map<string, number[]>();
  for (const [id, dia] of diaDe) idsDoDia.set(dia, [...(idsDoDia.get(dia) ?? []), id]);
  let falhasSeguidas = 0;
  let tentativas = 0;
  let tentativasEstoque = 0;
  let consultasFranquia = 0;

  for (const { lead, dono, estadoDoLead, estoque } of alvos) {
    // o teto conta só as gravações de verdade (seco, unidade desligada e contato não lido não gastam vaga)
    if (tentativas >= MAX_GRAVACOES_POR_RODADA) break;
    const cid = contatoPrincipal(lead);
    // contato que não veio na leitura: pode ser instabilidade do Kommo — tenta na próxima rodada. Passada meia hora é
    // contato apagado ou mesclado, que nunca vai vir: o lead vira "Lead dd/mm/aa" em vez de ficar "Lead #123" para sempre.
    const contatoAusente = cid !== null && !contatos.has(cid);
    // (título provisório sem contato lido: não há nome nem fallback a dar — espera o contato aparecer)
    if (contatoAusente && ((lead.created_at ?? 0) > agora - CONTATO_AUSENTE_DESISTE_S || !ehSemNome(lead.name))) {
      resumo.semContato++;
      continue;
    }
    if (contatoAusente) logger.warn({ unit: unit.slug, leadId: lead.id, contatoId: cid }, `${ID}: o contato do lead não existe mais — uso "Lead dd/mm/aa"`);
    const contato = cid !== null ? (contatos.get(cid) ?? null) : null;
    const quem = dono ?? { id: unit.id, slug: unit.slug };

    // A franquia: só para cartão de unidade conhecida (conta dividida sem ⌂ Unidade de atendimento não sabe qual franquia olhar).
    let franquia: NomesNaFranquia | null = null;
    // Só vale consultar quando o contato tem nome de pessoa: sem ele a franquia seria posta de lado de qualquer jeito (não há como
    // conferir o primeiro nome). Em ligado, estoque que já passou da cota de gravações desta rodada também não gasta consulta.
    const vaiConsultar = !!ctx.franquia && (!!dono || !membros?.length) && nomeDeGente(contato?.nome) !== null && !(estadoDoLead === 'ligado' && estoque && tentativasEstoque >= MAX_GRAVACOES_ESTOQUE_POR_RODADA);
    if (ctx.franquia && vaiConsultar) {
      const chaveCache = `${quem.id}|${chaveDoTelefone(contato?.telefone) ?? ''}`;
      const guardado = franquiaEmCache.get(chaveCache);
      if (guardado && guardado.ate > agora * 1000) {
        franquia = guardado.valor;
      } else if (consultasFranquia >= MAX_CONSULTAS_FRANQUIA_POR_RODADA) {
        resumo.adiados++;
        continue;
      } else {
        consultasFranquia++;
        franquia = await comTimeout(ctx.franquia(quem, contato?.telefone ?? null), TIMEOUT_FRANQUIA_MS).catch((err): NomesNaFranquia => ({ tipo: 'indisponivel', motivo: String(err).slice(0, 120) }));
        if (franquiaEmCache.size > 5000) franquiaEmCache.clear();
        // sem resposta também fica guardado, por pouco tempo: uma ficha que falha sempre não repete a mesma chamada a cada rodada
        franquiaEmCache.set(chaveCache, { ate: agora * 1000 + (franquia.tipo === 'indisponivel' ? FRANQUIA_INDISPONIVEL_VALE_MS : FRANQUIA_VALE_MS), valor: franquia });
      }
      // Franquia sem resposta: a franquia só completa o nome (o sobrenome do paciente), então espera algumas rodadas para não fixar
      // "Alex" quando era "Alex Sandre" por um tropeço, mas não trava o cartão para sempre: passadas as esperas, segue com o contato.
      if (franquia.tipo === 'indisponivel') {
        const esperas = (esperasDaFranquia.get(lead.id) ?? 0) + 1;
        if (esperasDaFranquia.size > 5000) esperasDaFranquia.clear();
        esperasDaFranquia.set(lead.id, esperas);
        logger.info({ unit: quem.slug, leadId: lead.id, motivo: franquia.motivo, esperas }, `${ID}: franquia sem resposta`);
        if (esperas <= MAX_ESPERAS_DA_FRANQUIA) {
          resumo.adiados++;
          continue;
        }
        franquia = null;
      }
    }

    const data = diaDe.get(lead.id) ?? dataCurta(lead.created_at ?? agora, tz);
    const doDia = (idsDoDia.get(data) ?? []).filter((id) => id !== lead.id).map((id) => nomes.get(id) ?? '');
    const plano = planejarRenomeacao({ nomeDoLead: lead.name, nomeDoContato: contato?.nome ?? null, franquia, data, nomesDoDia: doDia });
    if (!plano) continue;

    if (plano.tipo === 'deixa') {
      // nenhuma fonte deu nome e o título já era genérico: não troca um pelo outro. Fica anotado (uma vez por processo).
      resumo.semNomeParaDar++;
      if (semNomeAte.size > 5000) semNomeAte.clear();
      semNomeAte.set(lead.id, agora * 1000 + REVER_SEM_NOME_MS);
      if (!anunciadosSemNome.has(lead.id)) {
        anunciadosSemNome.add(lead.id);
        if (anunciadosSemNome.size > 5000) anunciadosSemNome.clear();
        logger.info({ unit: quem.slug, leadId: lead.id, titulo: lead.name, motivo: plano.motivo }, `${ID}${estadoDoLead === 'seco' ? ' [seco]' : ''}: sem nome para "${lead.name}" — ${plano.motivo}`);
        if (estadoDoLead === 'seco') registrar(quem, ID, { leadId: lead.id, acao: 'pularia', alvo: ALVO, valor: lead.name, noCartao: lead.name, motivo: plano.motivo });
      }
      continue;
    }
    const fonte = plano.tipo === 'nome' ? plano.fonte : 'sem-nome';
    const motivo = `${plano.motivo} [fonte: ${fonte}]`;

    if (estadoDoLead === 'seco') {
      resumo.simulados++;
      nomes.set(lead.id, plano.para);
      registrar(quem, ID, { leadId: lead.id, acao: 'gravaria', alvo: ALVO, valor: plano.para, noCartao: lead.name, motivo });
      if (!anunciados.has(lead.id)) {
        anunciados.add(lead.id);
        if (anunciados.size > 5000) anunciados.clear();
        logger.info({ unit: quem.slug, leadId: lead.id, de: lead.name, para: plano.para, tipo: plano.tipo, fonte, motivo: plano.motivo }, `${ID} [seco]: renomearia "${lead.name}" → "${plano.para}" (${fonte})`);
      }
      continue;
    }

    // estoque: poucas gravações por rodada, com pausa — não disputa a conta do Kommo com a Sofia
    if (estoque && tentativasEstoque >= MAX_GRAVACOES_ESTOQUE_POR_RODADA) {
      resumo.adiados++;
      continue;
    }
    // pausa ANTES de cada tentativa do estoque (a segunda em diante): vale também quando a anterior falhou ou o nome já tinha chegado
    if (estoque && tentativasEstoque > 0) await new Promise((r) => setTimeout(r, ctx.pausaMs ?? PAUSA_ENTRE_ESCRITAS_MS));
    tentativas++;
    if (estoque) tentativasEstoque++;
    try {
      // a SDR pode ter nomeado enquanto líamos os contatos: relê antes de gravar
      const atual = await kommo.getLead(lead.id);
      if (!ehTituloGenerico(atual.name) || (atual.name ?? '').trim() !== (lead.name ?? '').trim()) {
        resumo.jaNomeados++;
        logger.info({ unit: quem.slug, leadId: lead.id, nome: atual.name }, `${ID}: o nome chegou antes — não sobrescrevo`);
        continue;
      }
      await kommo.updateLeadName(lead.id, plano.para);
      nomes.set(lead.id, plano.para);
      resumo.gravados++;
      falhasSeguidas = 0;
      logger.info({ unit: quem.slug, leadId: lead.id, de: lead.name, para: plano.para, tipo: plano.tipo, fonte, motivo: plano.motivo }, `${ID}: lead renomeado (${fonte})`);
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
  await renomearConta({ unit, membros, kommo: createKommoClient(unit), estadoDe, agora: Math.floor(Date.now() / 1000), franquia: nomesNaFranquiaPadrao, garantirIndice: garantirIndicePadrao });
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
