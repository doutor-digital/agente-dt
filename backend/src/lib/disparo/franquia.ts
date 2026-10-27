/**
 * "Esta pessoa tem consulta marcada ou tratamento aberto na franquia?" — a regra que custou caro no Outubro Rosa
 * (lista de 13/10 mandou resgate a quem já estava na agenda: Ariana em Canaã, Helena na Açailândia).
 *
 * Duas redes, porque cada uma sozinha deixa passar gente:
 *  1. o PACIENTE: acha o idClient (vínculo da Sofia → telefone → nome exato) e lê a ficha — agenda e tratamentos dele;
 *  2. a AGENDA da unidade: nomes com consulta marcada e com tratamento aberto, para pegar quem o cadastro não casou
 *     (o contato do Kommo escrito de outro jeito). Casa por nome inteiro normalizado, e errar aqui é pelo lado
 *     seguro: homônimo deixa de receber, ninguém recebe a mais.
 * Falha da franquia NUNCA vira "livre": vira `indisponivel`, e quem chama não manda.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../logger.js';
import { SPINE_STATUS, getClient, searchSchedules, searchTreatments, type SpineSchedule } from '../../services/spine.service.js';
import { idClientDoLead } from '../franquia-sync-worker.js';
import { normalizar } from '../franquia-sync.js';
import { tratamentoAberto } from '../franquia-move.js';
import { dataLocalISO } from '../feriados.js';
import { fusoDaUnidade } from '../fuso.js';
import type { SituacaoNaFranquia } from './regras.js';

/** Por quanto tempo uma leitura FALHA da agenda vale antes de tentar de novo. */
const FALHA_VALE_MS = 60_000;

/** Quanto da agenda à frente a segunda rede lê. */
const DIAS_A_FRENTE = 180;

/**
 * A API da franquia recusa intervalo maior que 100 dias (HTTP 400 "Intervalo de datas não pode ser maior que 100 dias.").
 * A leitura de 180 dias numa chamada só NUNCA funcionou em produção: a segunda rede caía em 'indisponivel' e a onda de
 * Canaã de 27/10 perdeu 45 de 50 pessoas por "a franquia não respondeu". Daí as janelas: cada uma cobre `[de, de + 90]`
 * (91 dias; com o fim exclusivo que `searchSchedules` manda, 92 de intervalo) — folga confortável sob os 100.
 */
const DIAS_POR_JANELA = 90;

/** As janelas `[inicio, fim]` (AAAA-MM-DD, as duas pontas incluídas) que cobrem `hoje` até `hoje + diasAFrente`, sem sobrepor. */
export function janelasDaAgenda(hoje: string, diasAFrente: number = DIAS_A_FRENTE, diasPorJanela: number = DIAS_POR_JANELA): Array<[string, string]> {
  const janelas: Array<[string, string]> = [];
  for (let de = 0; de <= diasAFrente; de += diasPorJanela + 1) {
    janelas.push([somarDias(hoje, de), somarDias(hoje, Math.min(de + diasPorJanela, diasAFrente))]);
  }
  return janelas;
}

/**
 * Agendamento que ainda vai acontecer. Mais largo que `temConsultaFutura` do sincronizador (que só olha avaliação e
 * retorno): aqui QUALQUER categoria marcada barra — sessão também. REMARCADO conta: a franquia mantém a data nova no
 * mesmo registro e o paciente vem naquele dia.
 */
export function temAgendamentoFuturo(schedules: ReadonlyArray<Pick<SpineSchedule, 'dateAttendanceUtc' | 'idStatus'>>, agoraEpoch: number): boolean {
  return schedules.some((s) => {
    if (!s.dateAttendanceUtc) return false;
    const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
    const marcado = s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO || s.idStatus === SPINE_STATUS.REMARCADO;
    return Number.isFinite(t) && t > agoraEpoch && marcado;
  });
}

interface RedeDaAgenda {
  comConsulta: Set<string>;
  comTratamento: Set<string>;
}

function somarDias(dia: string, n: number): string {
  return new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/** As chamadas à franquia. Em produção são as de verdade; o teste troca por uma franquia de mentira. */
export interface FranquiaPorta {
  searchSchedules: typeof searchSchedules;
  searchTreatments: typeof searchTreatments;
  getClient: typeof getClient;
  idClientDoLead: typeof idClientDoLead;
}
const FRANQUIA_DE_VERDADE: FranquiaPorta = { searchSchedules, searchTreatments, getClient, idClientDoLead };

async function lerRedeDaAgenda(unit: Unit, agora: Date, f: FranquiaPorta): Promise<RedeDaAgenda | null> {
  const hoje = dataLocalISO(agora, fusoDaUnidade(unit));
  // Em janelas de até 100 dias (ver DIAS_POR_JANELA), uma depois da outra: a franquia não leva 2 chamadas pesadas ao mesmo tempo.
  // Qualquer janela que falhe ou venha cortada no teto de páginas invalida a leitura TODA e as seguintes nem são pedidas.
  // 100 por página (o máximo): com 50 o teto de 40 páginas corta em 2.000 agendamentos e a leitura parece completa.
  const agendamentos: Array<Pick<SpineSchedule, 'clientName' | 'dateAttendanceUtc' | 'idStatus'>> = [];
  for (const [inicio, fim] of janelasDaAgenda(hoje)) {
    const ag = await f.searchSchedules(unit, { initialDate: inicio, endDate: fim, rowsPerPage: 100 });
    if (!ag.ok || !ag.data) {
      logger.warn({ unit: unit.slug, janela: `${inicio}..${fim}`, agenda: ag.error }, 'disparo: não consegui ler a agenda da franquia');
      return null;
    }
    // Leitura cortada no teto de páginas = lista incompleta: quem estaria depois do corte passaria como "livre" (foi assim
    // que o Outubro Rosa mandou resgate a quem já tinha consulta). Incompleta é INDISPONÍVEL, e indisponível não manda.
    if (ag.data.truncada) {
      logger.warn({ unit: unit.slug, janela: `${inicio}..${fim}` }, 'disparo: a leitura da agenda da franquia foi cortada no teto de páginas — tratada como indisponível');
      return null;
    }
    // Sem repetição na junção: as janelas não se sobrepõem e `searchSchedules` já filtra pelo DIA LOCAL dentro de cada uma,
    // então a consulta da beira cai numa só; e o que se guarda são nomes num Set, onde repetir seria inofensivo de qualquer jeito.
    agendamentos.push(...ag.data.schedules);
  }
  const tr = await f.searchTreatments(unit, {});
  if (!tr.ok || !tr.data) {
    logger.warn({ unit: unit.slug, tratamentos: tr.error }, 'disparo: não consegui ler os tratamentos da franquia');
    return null;
  }
  if (tr.data.truncada) {
    logger.warn({ unit: unit.slug }, 'disparo: a leitura dos tratamentos da franquia foi cortada no teto de páginas — tratada como indisponível');
    return null;
  }
  const epoch = Math.floor(agora.getTime() / 1000);
  const comConsulta = new Set<string>();
  for (const s of agendamentos) if (s.clientName && temAgendamentoFuturo([s], epoch)) comConsulta.add(normalizar(s.clientName));
  const comTratamento = new Set<string>();
  for (const t of tr.data.treatments) if (t.clientName && tratamentoAberto({ idStatus: null, statusName: t.statusName })) comTratamento.add(normalizar(t.clientName));
  return { comConsulta, comTratamento };
}

export interface PessoaParaConferir {
  leadId: number | null;
  /** nome completo do contato */
  nomeCompleto: string;
  /** só dígitos com DDI */
  telefone: string;
}

/**
 * A conferência de uma unidade. A leitura em bloco da agenda acontece UMA vez por conferência e é guardada;
 * cada pessoa custa só a busca do paciente.
 */
export function conferenciaDaFranquia(unit: Unit, agora: () => Date = () => new Date(), f: FranquiaPorta = FRANQUIA_DE_VERDADE): (p: PessoaParaConferir) => Promise<SituacaoNaFranquia> {
  let rede: { lidaEm: number; falhou: boolean; dados: Promise<RedeDaAgenda | null> } | null = null;
  return async (p) => {
    if (!unit.spineToken) return 'indisponivel';
    try {
      // Leitura boa vale pela conferência inteira. Falha vale só por 1 minuto: um soluço da franquia não pode
      // condenar a lista toda, e tentar de novo a cada pessoa seria martelar uma franquia que já está fora.
      if (!rede || (rede.falhou && Date.now() - rede.lidaEm > FALHA_VALE_MS)) {
        const atual = { lidaEm: Date.now(), falhou: false, dados: lerRedeDaAgenda(unit, agora(), f) };
        atual.dados.then((b) => void (atual.falhou = !b), () => void (atual.falhou = true));
        rede = atual;
      }
      const bloco = await rede.dados;
      if (!bloco) return 'indisponivel';

      const idClient = p.leadId ? await f.idClientDoLead(unit, p.leadId, p.nomeCompleto, { fone: p.telefone }) : null;
      if (idClient) {
        const r = await f.getClient(unit, idClient);
        if (!r.ok) return 'indisponivel';
        const ficha = r.data?.client;
        if (ficha) {
          if (temAgendamentoFuturo(ficha.schedules, Math.floor(agora().getTime() / 1000))) return 'consulta-futura';
          if (ficha.treatments.some((t) => tratamentoAberto({ idStatus: t.idStatus, statusName: t.statusName }))) return 'tratamento-aberto';
        }
      }
      const nome = normalizar(p.nomeCompleto);
      if (nome && bloco.comConsulta.has(nome)) return 'consulta-futura';
      if (nome && bloco.comTratamento.has(nome)) return 'tratamento-aberto';
      return 'livre';
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: p.leadId }, 'disparo: conferência da franquia falhou — pessoa fica de fora');
      return 'indisponivel';
    }
  };
}
