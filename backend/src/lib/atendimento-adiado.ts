/**
 * O PACIENTE QUE ESCREVEU ANTES DE O CARTÃO TER UNIDADE (conta dividida: Petrópolis × Caxias, doutorhernialvp).
 *
 * O portão de `crm-compartilhado.ts` cala a Sofia num cartão sem «⌂ Unidade de atendimento» (ou que não deu para ler): sem
 * trace, sem conversa, sem mensagem guardada. Quem preenche o campo é o robô `unidade-por-canal` (varredura de 5 min) ou a SDR.
 * Caso real, 03/11/2026, cartão 5014067: o paciente escreveu "Olá, quero agendar uma avaliação" às 17:14, veio de anúncio; o
 * robô marcou Petrópolis às 17:46 — e a mensagem das 17:14 ficou SEM resposta para sempre (ninguém a tinha guardado) e o lead
 * nunca foi cadastrado na franquia (o cadastro roda no fim do turno da IA, e o turno nunca existiu).
 *
 * O que este arquivo faz, em duas partes:
 *
 *  1. O portão deixa uma MARCA DURÁVEL no cartão (`card_alert`, a mesma tabela dos avisos por lead — sem migration) quando cala
 *     por `sem-unidade` ou `ilegivel` (os dois casos em que o cartão ainda pode vir a ser da unidade). Cartão da irmã
 *     (Caxias) e valor que ninguém usa NÃO deixam marca: não são de ninguém que esta unidade atenda.
 *
 *  2. A cada varredura do robô (`retomarCartoesCalados`), para cada marca das últimas 24 h que ainda não foi tratada: lê o
 *     cartão; se agora é DESTA unidade, `atenderCartaoQueGanhouUnidade`:
 *       - lê a conversa OFICIAL do Kommo (é o único lugar onde a fala daquele período existe);
 *       - se o paciente ficou esperando (última fala é dele, sem resposta de ninguém) e a espera é recente, a unidade está no
 *         horário e nada do nosso lado já rodou depois dela, REINICIA O TURNO DA IA com as falas dele — pelo mesmo
 *         `processAgent`, então horário, pausa, etapa liberada e "a equipe falou" valem como em qualquer mensagem;
 *       - se não pôde iniciar o turno (fora do horário, espera velha, só mídia, paciente atendido, turno já feito), ainda
 *         assim tenta o CADASTRO na franquia, com as falas e o telefone lidos do Kommo (o banco não tem nada deste cartão).
 *       - quando o turno é iniciado, o cadastro vem do fim dele (ou do ramo "IA pulada" do `processAgent`).
 *     Cada espera é reivindicada uma vez só (`message_claims`, com certeza: sem certeza, não refaz — resposta em dobro é pior
 *     que atraso) e a marca ganha um carimbo de "tratado".
 *
 * O que NÃO muda: o cadastro continua sendo `cadastrarLeadDoTurno` (chave `cadastro-todo-lead`, NUMEROS_INTERNOS, trava de 3+
 * unidades, triagem por IA, nome + sobrenome, casamento-jornada) e `syncLeadToSpine` ainda confere o cartão e o token da unidade
 * (`escritaConferida`): cartão de Caxias ou sem unidade nunca é gravado na franquia de Petrópolis.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { marcarAviso } from './aviso-dedupe.js';
import { liberarClaim, reivindicarComCerteza } from './dedup-cache.js';
import { esperaDoPaciente, type EsperaDoPaciente } from './sem-resposta-worker.js';
import { cadastrarLeadDoTurno, depsPadrao as depsDoCadastro, type DepsDoCadastro, type SincronizarLead } from './cadastro-todo-lead.js';
import { grupoDaUnidade, valorDaUnidadeNoCartao, veredictoDoCartao } from './crm-compartilhado.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { mensagensOficiaisDaUnidade, type MensagemOficial } from '../services/kommo-talks.service.js';
import { SpineSyncService } from '../services/spine-sync.service.js';

/** O portão calou a Sofia num cartão que ainda pode vir a ser desta unidade. `created_at` = a última fala calada. */
export const REGRA_CALADA_SEM_UNIDADE = 'sofia_calada_sem_unidade';
/** Esta marca já foi tratada: `created_at` >= o da marca acima. */
export const REGRA_RETOMADA_AO_GANHAR_UNIDADE = 'sofia_retomada_ao_ganhar_unidade';
export const ESCOPO_DA_RETOMADA = 'unidade-ganha';

/** Quanto tempo uma marca vale (fora disso o cartão é assunto da equipe e do alerta de "sem resposta"). */
export const JANELA_DA_MARCA_MS = 24 * 3600_000;
/** Espera mais velha que isto não é respondida por uma IA acordando do nada: a recepção já viu (ou deveria ter visto). */
export const IDADE_MAXIMA_DA_ESPERA_MS = 2 * 3600_000;
/** Quantas marcas uma varredura trata (cada uma lê o cartão e a conversa no Kommo). */
export const MAX_MARCAS_POR_VARREDURA = 25;

/** Os tipos do portão que deixam marca. */
export function deixaMarcaDeCalada(tipo: string): boolean {
  return tipo === 'sem-unidade' || tipo === 'ilegivel';
}

/** O portão cala e anota (nunca lança: o aviso-dedupe engole falha de banco). */
export async function marcarCartaoCalado(unitId: string, leadId: number): Promise<void> {
  await marcarAviso(unitId, leadId, REGRA_CALADA_SEM_UNIDADE);
}

export interface PedidoDeTurno {
  unit: Unit;
  leadId: number;
  /** As falas do paciente desde a última saída, em ordem, sem as vazias. */
  textos: string[];
  /** Quando a espera começou (a 1ª fala sem resposta). */
  desde: Date;
  contactId: number | null;
  telefone: string | null;
}

export type IniciaTurno = (pedido: PedidoDeTurno) => Promise<void>;

let iniciador: IniciaTurno | null = null;
/** Registrado no boot (server.ts) com a função do controller — evita o ciclo worker → controller. */
export function definirIniciadorDoTurno(fn: IniciaTurno | null): void {
  iniciador = fn;
}

export interface DepsDoAdiado {
  agora(): number;
  conversaOficial(unit: Unit, leadId: number): Promise<MensagemOficial[]>;
  /** Um turno normal (resposta da IA ou turno que o webhook abriu) já cuidou deste cartão desde `desde`? A fala do paciente guardada, sozinha, não conta. */
  jaHouveMensagemDesde(unit: Unit, leadId: number, desde: Date): Promise<boolean>;
  horarioAberto(unit: Unit): boolean;
  reivindicar(chave: string): Promise<'ganhou' | 'perdeu' | 'incerto'>;
  /** Devolve a reivindicação (o turno não subiu): a próxima varredura pode tentar de novo. */
  liberar(chave: string): Promise<void>;
  iniciarTurno: IniciaTurno | null;
  sincronizar: SincronizarLead<Unit>;
  depsDoCadastro: DepsDoCadastro;
}

export const depsPadraoDoAdiado = (): DepsDoAdiado => ({
  agora: () => Date.now(),
  conversaOficial: (unit, leadId) => mensagensOficiaisDaUnidade(unit, createKommoClient(unit), leadId, 40),
  async jaHouveMensagemDesde(unit, leadId, desde) {
    // Resposta nossa (papel assistant). A fala do PACIENTE guardada não conta: o próprio turno atrasado a grava antes de subir, e um
    // turno que falhou no meio nunca poderia ser refeito (ficaria "já atendido" por causa da fala que ele mesmo guardou).
    const resposta = await prisma.message.findFirst({
      where: { role: 'assistant', createdAt: { gte: desde }, conversation: { unitId: unit.id, leadId: String(leadId) } },
      select: { id: true },
    });
    if (resposta) return true;
    // Turno aberto pelo webhook normal (o paciente escreveu de novo depois da marcação) e ainda sem resposta gravada: não abrir um
    // segundo. O turno aberto por este arquivo (`via: unidade_ganha`) não conta — a reivindicação já o protege.
    const traces = await prisma.executionTrace.findMany({
      where: { unitId: unit.id, leadId: String(leadId), createdAt: { gte: desde } },
      select: { input: true },
      take: 20,
    });
    return traces.some((t) => (t.input as { via?: string } | null)?.via !== 'unidade_ganha');
  },
  horarioAberto(unit) {
    const h = checkBusinessHours(unit);
    return !h.enabled || h.isOpen;
  },
  reivindicar: (chave) => reivindicarComCerteza(ESCOPO_DA_RETOMADA, chave, JANELA_DA_MARCA_MS),
  liberar: (chave) => liberarClaim(ESCOPO_DA_RETOMADA, chave),
  iniciarTurno: iniciador,
  sincronizar: SpineSyncService.syncLeadToSpine,
  depsDoCadastro,
});

export type MotivoSemTurno =
  | 'sem-espera'
  | 'espera-velha'
  | 'so-midia'
  | 'fora-do-horario'
  | 'ja-atendido'
  | 'ja-reivindicado'
  | 'reivindicacao-incerta'
  | 'sem-iniciador'
  | 'falha-ao-iniciar';

export interface ResultadoDoAdiado {
  /**
   * `erro`: não deu para ler a conversa — nada foi feito. `adiar`: não deu para decidir com certeza (reivindicação incerta, turno que
   * não subiu, iniciador ausente) ou a IA ainda não abriu (fora do horário, espera ainda dentro do prazo) — nada ficou reivindicado
   * nem cadastrado e a marca fica para a próxima varredura; quando a espera passar do prazo, a decisão vira `espera-velha` e cadastra. `nao`: decisão definitiva.
   */
  turno: 'iniciado' | 'nao' | 'erro' | 'adiar';
  motivo?: MotivoSemTurno;
  /** Quanto o paciente esperava (da 1ª fala sem resposta até agora), em minutos. */
  esperouMin?: number;
  cadastro?: 'decidido' | 'pulado';
}

/** PURA: as falas da espera que o modelo pode ler (sem as de mídia sem texto). */
export function textosDaEspera(espera: Pick<EsperaDoPaciente, 'textos'>): string[] {
  return espera.textos.map((t) => String(t ?? '').trim()).filter(Boolean);
}

/** PURA: as falas do paciente (nunca as da equipe nem da IA) da conversa oficial, das mais antigas às mais novas, até `max`. */
export function falasDoPacienteNaConversa(msgs: readonly MensagemOficial[], max = 10): string[] {
  return [...msgs]
    .filter((m) => m.direcao === 'entrada')
    .sort((a, b) => a.em.getTime() - b.em.getTime())
    .map((m) => String(m.texto ?? '').trim())
    .filter(Boolean)
    .slice(-max);
}

/**
 * O cartão de `leadId` acabou de ser confirmado como DESTA unidade. Atende o que ficou esperando e cadastra.
 * Nunca lança.
 */
export async function atenderCartaoQueGanhouUnidade(
  entrada: { unit: Unit; leadId: number; contactId: number | null; telefone: string | null },
  deps: DepsDoAdiado = depsPadraoDoAdiado(),
): Promise<ResultadoDoAdiado> {
  const { unit, leadId } = entrada;
  let msgs: MensagemOficial[];
  try {
    msgs = await deps.conversaOficial(unit, leadId);
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'atendimento-adiado: não consegui ler a conversa oficial — tento na próxima varredura');
    return { turno: 'erro' };
  }

  const espera = esperaDoPaciente(msgs);
  let motivo: MotivoSemTurno | undefined;
  let esperouMin: number | undefined;
  let iniciou = false;

  if (!espera) {
    motivo = 'sem-espera';
  } else {
    const textos = textosDaEspera(espera);
    esperouMin = Math.round((deps.agora() - espera.desde.getTime()) / 60_000);
    if (deps.agora() - espera.ultimaEm.getTime() > IDADE_MAXIMA_DA_ESPERA_MS) motivo = 'espera-velha';
    else if (textos.length === 0) motivo = 'so-midia';
    else if (!deps.horarioAberto(unit)) motivo = 'fora-do-horario'; // adia: a IA abre mais tarde e a espera ainda pode ser respondida
    else if (await deps.jaHouveMensagemDesde(unit, leadId, espera.desde).catch(() => true)) motivo = 'ja-atendido';
    else if (!deps.iniciarTurno) motivo = 'sem-iniciador';
    else {
      // Uma vez só por espera: a chave é o início dela (estável enquanto ninguém responde). Sem certeza, não refaz.
      const chave = `${unit.id}:${leadId}:${espera.desde.getTime()}`;
      const r = await deps.reivindicar(chave);
      if (r === 'perdeu') motivo = 'ja-reivindicado';
      else if (r === 'incerto') motivo = 'reivindicacao-incerta';
      else {
        try {
          await deps.iniciarTurno({ unit, leadId, textos, desde: espera.desde, contactId: entrada.contactId, telefone: entrada.telefone });
          iniciou = true;
        } catch (err) {
          logger.warn({ err: String(err), leadId, unit: unit.slug }, 'atendimento-adiado: falha ao iniciar o turno atrasado');
          await deps.liberar(chave).catch(() => undefined);
          motivo = 'falha-ao-iniciar';
        }
      }
    }
  }

  if (iniciou) {
    logger.info({ leadId, unit: unit.slug, esperouMin }, 'atendimento-adiado: cartão ganhou a unidade — turno da IA iniciado para quem esperava');
    // O cadastro vem do fim do turno (ou do ramo "IA pulada" do processAgent).
    return { turno: 'iniciado', esperouMin };
  }

  const foraDoHorario = motivo === 'fora-do-horario';
  // Fora do horário a varredura volta a cada 5 min até a IA abrir (ou a espera vencer): uma linha por varredura seria ruído.
  (foraDoHorario ? logger.debug : logger.info).call(logger, { leadId, unit: unit.slug, motivo, esperouMin }, 'atendimento-adiado: cartão ganhou a unidade — turno NÃO iniciado');
  // `adiar`: a marca fica e a próxima varredura volta aqui — decidir o cadastro agora o repetiria a cada 5 min e, depois, o turno
  // que vier cadastraria de novo com outras falas. Só a decisão definitiva cadastra.
  const adiar = motivo === 'reivindicacao-incerta' || motivo === 'sem-iniciador' || motivo === 'falha-ao-iniciar' || motivo === 'fora-do-horario';
  if (adiar) return { turno: 'adiar', motivo, esperouMin };
  // Outro turno já cuida deste paciente (e cadastra no fim dele): cadastrar daqui seria uma segunda leitura, com falas diferentes.
  const cadastro = motivo === 'ja-atendido' || motivo === 'ja-reivindicado' ? undefined : await cadastrarSemTurno(entrada, msgs, deps);
  return { turno: 'nao', motivo, esperouMin, cadastro };
}

/**
 * O cadastro de quem não teve turno: telefone e falas vêm do Kommo (o banco não tem conversa deste cartão). As travas são as de
 * sempre — é a mesma `cadastrarLeadDoTurno`, só com as duas leituras trocadas.
 */
async function cadastrarSemTurno(
  entrada: { unit: Unit; leadId: number; telefone: string | null },
  msgs: readonly MensagemOficial[],
  deps: DepsDoAdiado,
): Promise<'decidido' | 'pulado'> {
  const { unit, leadId, telefone } = entrada;
  if (!unit.spineSyncLeads) return 'pulado';
  const falas = falasDoPacienteNaConversa(msgs);
  try {
    const { decisao, execucao } = await cadastrarLeadDoTurno(
      { unit, leadId, ferramentas: [] },
      deps.sincronizar,
      {
        ...deps.depsDoCadastro,
        telefoneDaConversa: async (unitId, id) => telefone ?? deps.depsDoCadastro.telefoneDaConversa(unitId, id),
        falasDoPaciente: async () => falas,
      },
    );
    if (!decisao.criar && !decisao.silenciosa) {
      logger.info({ leadId, unit: unit.slug, motivo: decisao.motivo }, 'spine-sync: não criei na franquia (cartão que ganhou a unidade)');
    }
    await execucao;
    return 'decidido';
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'atendimento-adiado: falha ao decidir o cadastro');
    return 'pulado';
  }
}

// ── a varredura: marcas do portão × cartão que agora é desta unidade ─────────────────────────────

export interface ResumoDaRetomada {
  marcas: number;
  retomados: number;
  aguardando: number;
  deOutra: number;
  erros: number;
}

export interface DepsDaVarredura {
  agora(): number;
  /** As marcas do portão ainda NÃO tratadas (sem carimbo de "tratado" igual ou mais novo), das mais novas para as mais antigas. */
  marcasPendentes(unitId: string, desde: Date): Promise<Array<{ leadId: number; em: Date }>>;
  marcarTratado(unitId: string, leadId: number): Promise<void>;
  lerCartao(leadId: number): Promise<KommoLead>;
  telefoneDoContato(contactId: number): Promise<string | null>;
  atender(entrada: { unit: Unit; leadId: number; contactId: number | null; telefone: string | null }): Promise<ResultadoDoAdiado>;
}

/** PURA: das linhas de `card_alert`, os cartões cuja marca de "calada" é mais nova que o carimbo de "tratado" (ou não tem carimbo). Mais novas primeiro. */
export function pendentesDe(linhas: ReadonlyArray<{ leadId: string; regra: string; em: Date }>): Array<{ leadId: number; em: Date }> {
  const calada = new Map<string, Date>();
  const tratado = new Map<string, Date>();
  for (const l of linhas) {
    if (l.regra === REGRA_CALADA_SEM_UNIDADE) calada.set(l.leadId, l.em);
    else if (l.regra === REGRA_RETOMADA_AO_GANHAR_UNIDADE) tratado.set(l.leadId, l.em);
  }
  const out: Array<{ leadId: number; em: Date }> = [];
  for (const [leadId, em] of calada) {
    const t = tratado.get(leadId);
    const id = Number(leadId);
    if ((!t || t.getTime() < em.getTime()) && Number.isFinite(id) && id > 0) out.push({ leadId: id, em });
  }
  return out.sort((a, b) => b.em.getTime() - a.em.getTime());
}

export function depsDaVarreduraPadrao(kommo: KommoClient, unitId: string): DepsDaVarredura {
  return {
    agora: () => Date.now(),
    async marcasPendentes(uid, desde) {
      // Uma consulta só para as duas regras: filtrar as já tratadas ANTES de cortar a lista (senão as tratadas ocupam as vagas).
      const rows = await prisma.cardAlert.findMany({
        where: { unitId: uid, ruleKey: { in: [REGRA_CALADA_SEM_UNIDADE, REGRA_RETOMADA_AO_GANHAR_UNIDADE] }, createdAt: { gte: desde } },
        select: { leadId: true, ruleKey: true, createdAt: true },
      });
      return pendentesDe(rows.map((r) => ({ leadId: r.leadId, regra: r.ruleKey, em: r.createdAt })));
    },
    marcarTratado: (uid, leadId) => marcarAviso(uid, leadId, REGRA_RETOMADA_AO_GANHAR_UNIDADE),
    lerCartao: (leadId) => kommo.getLead(leadId),
    telefoneDoContato: (contactId) => kommo.getContactPhone(contactId),
    atender: (entrada) => atenderCartaoQueGanhouUnidade(entrada),
  };
}

const contatoPrincipalDe = (lead: KommoLead): number | null => {
  const cs = lead._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
};

/** Seco: a mesma conta, sem agir. Uma linha por lead e processo, não a cada 5 minutos. */
const vistosNoSeco = new Set<number>();

/**
 * Chamada ao fim de cada varredura do `unidade-por-canal` (quem acabou de gravar a unidade, ou a SDR, já está no cartão).
 * `seco` = só conta e loga o que faria. Nunca lança.
 */
export async function retomarCartoesCalados(
  unit: Unit,
  seco: boolean,
  deps: DepsDaVarredura,
): Promise<ResumoDaRetomada> {
  const resumo: ResumoDaRetomada = { marcas: 0, retomados: 0, aguardando: 0, deOutra: 0, erros: 0 };
  try {
    const grupo = await grupoDaUnidade(unit.id);
    if (!grupo) return resumo; // Kommo de uma unidade só: o portão nunca cala, não há marca
    const marcas = (await deps.marcasPendentes(unit.id, new Date(deps.agora() - JANELA_DA_MARCA_MS))).slice(0, MAX_MARCAS_POR_VARREDURA);
    resumo.marcas = marcas.length;
    for (const marca of marcas) {
      try {
        const lead = await deps.lerCartao(marca.leadId);
        const v = veredictoDoCartao(grupo, unit.id, valorDaUnidadeNoCartao(lead));
        if (v.tipo === 'outra') {
          resumo.deOutra++;
          if (!seco) await deps.marcarTratado(unit.id, marca.leadId);
          continue;
        }
        if (v.tipo !== 'desta') {
          resumo.aguardando++;
          continue;
        }
        if (seco) {
          if (!vistosNoSeco.has(marca.leadId)) {
            if (vistosNoSeco.size > 5_000) vistosNoSeco.clear();
            vistosNoSeco.add(marca.leadId);
            logger.info({ leadId: marca.leadId, unit: unit.slug, calouHaMin: Math.round((deps.agora() - marca.em.getTime()) / 60_000) }, 'atendimento-adiado [seco]: retomaria o cartão que ganhou a unidade');
          }
          continue;
        }
        const contactId = contatoPrincipalDe(lead);
        const telefone = contactId ? await deps.telefoneDoContato(contactId).catch(() => null) : null;
        const r = await deps.atender({ unit, leadId: marca.leadId, contactId, telefone });
        if (r.turno === 'adiar' && r.motivo === 'fora-do-horario') {
          resumo.aguardando++;
          continue; // a IA ainda não abriu: sem carimbo, a próxima varredura olha de novo
        }
        if (r.turno === 'erro' || r.turno === 'adiar') {
          resumo.erros++;
          continue; // fica sem carimbo: a próxima varredura tenta de novo
        }
        resumo.retomados++;
        logger.info(
          { leadId: marca.leadId, unit: unit.slug, calouHaMin: Math.round((deps.agora() - marca.em.getTime()) / 60_000), turno: r.turno, motivo: r.motivo, esperouMin: r.esperouMin },
          'atendimento-adiado: cartão que estava calado ganhou a unidade e foi tratado',
        );
        await deps.marcarTratado(unit.id, marca.leadId);
      } catch (err) {
        resumo.erros++;
        logger.warn({ err: String(err), leadId: marca.leadId, unit: unit.slug }, 'atendimento-adiado: falha ao reavaliar o cartão calado');
      }
    }
  } catch (err) {
    resumo.erros++;
    logger.warn({ err: String(err), unit: unit.slug }, 'atendimento-adiado: varredura falhou');
  }
  return resumo;
}

/** Só para teste. */
export function _limparParaTeste(): void {
  vistosNoSeco.clear();
}

