/**
 * "Esse paciente já tem consulta de pé — em QUALQUER cadastro dele na franquia?"
 *
 * Caso Ana Christina (Timbó, 29/10/2026): a IA usava o cadastro 374228. A recepção criou OUTRO cadastro da mesma
 * paciente (374234, mesmo nome e telefone) e marcou nele sexta 16:00. Na hora em que a paciente disse "ok, obrigada", a
 * IA tentou marcar 16:00 no 374228, a franquia disse "ocupado" (pela consulta da própria paciente) e a IA ofereceu
 * outro horário a quem já estava marcada. A proteção do caso Bebedouro (21/10) só olhava a agenda do idClient que a IA
 * passou — com cadastro em dobro ela nunca via a consulta.
 *
 * Aqui a pergunta é por PESSOA: o cadastro pedido + os outros cadastros com o mesmo telefone (8 últimos dígitos) e nome
 * compatível. A franquia não busca por telefone (`/clients/search` ignora o parâmetro), então a busca é por NOME — nos mesmos
 * termos do widget (`termosDeBusca`: nome inteiro, "primeiro último", só o primeiro: a recepção escreve o nome de outro jeito)
 * — e o telefone filtra o resultado. Nada aqui grava coisa nenhuma: só lê.
 *
 * `incompleta` é a resposta honesta de "não consegui ver tudo" (a busca ou a leitura de algum cadastro falhou): quem chama
 * NÃO pode tratar a falta de consulta como prova de que não há.
 */
import type { Unit } from '@prisma/client';
import { SpineService, type SpineSchedule } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { nomesCompativeis } from './casamento-jornada.js';
import { fim8 } from './paciente-existente.js';
import { termosDeBusca } from './widget-agenda.js';
import { logger } from './logger.js';

export interface CadastroLido {
  idClient: number;
  name: string | null;
  whatsapp: string | null;
  schedules: SpineSchedule[];
}

export interface ConsultaDePe {
  /** o cadastro onde a consulta está */
  idClient: number;
  schedule: SpineSchedule;
}

export interface ConferenciaDeCadastros {
  /** a consulta de pé mais próxima entre todos os cadastros (o pedido incluído); `null` = nenhuma vista */
  consulta: ConsultaDePe | null;
  /** os OUTROS cadastros do mesmo paciente (mesmo telefone, nome compatível) */
  duplicados: number[];
  /** algo falhou (busca, página cheia ou leitura de um cadastro): "nenhuma consulta" NÃO está provado */
  incompleta: boolean;
}

/** Quantos cadastros irmãos se leem no máximo (cada um é uma chamada à franquia). */
const MAX_IRMAOS = 5;
const POR_PAGINA = 100;

type Franquia = Pick<typeof SpineService, 'searchClients' | 'getClient'>;

function quando(s: SpineSchedule): string {
  return `${s.dayLocal}T${s.timeLocal}`;
}

export async function conferirConsultaDePe(
  unit: Unit,
  p: {
    paciente: CadastroLido;
    /** telefones que o lead conhece (contato do Kommo, o que o paciente informou) — além do próprio do cadastro */
    fones: ReadonlyArray<string | null | undefined>;
    /** AAAA-MM-DDTHH:mm no fuso da clínica */
    agoraLocal: string;
  },
  franquia: Franquia = SpineService,
): Promise<ConferenciaDeCadastros> {
  const { paciente } = p;
  const propria = AgendaReconcileService.avaliacaoDePe(paciente.schedules, p.agoraLocal);
  const achadas: ConsultaDePe[] = propria ? [{ idClient: paciente.idClient, schedule: propria }] : [];
  const duplicados: number[] = [];
  let incompleta = false;

  const chaves = new Set(
    [paciente.whatsapp, ...p.fones].map(fim8).filter((x): x is string => x !== null),
  );
  const nome = paciente.name?.trim() ?? '';
  // sem telefone ou sem nome não há como provar que outro cadastro é a MESMA pessoa: não se procura (e não se chuta)
  if (chaves.size > 0 && nome) {
    try {
      const termos = termosDeBusca(nome, nome);
      const buscas = await Promise.all(termos.map((t) => franquia.searchClients(unit, t, POR_PAGINA).catch(() => null)));
      const irmaos = new Map<number, string | null>();
      buscas.forEach((busca, i) => {
        if (!busca?.ok || !busca.data) {
          incompleta = true; // um termo que falhou era talvez justamente o que acharia o irmão
          return;
        }
        // página cheia no nome INTEIRO = pode haver mais gente com esse nome do que veio; nos termos largos ("Ana") a página
        // cheia é o normal e o telefone é quem decide
        if (i === 0 && busca.data.clients.length >= POR_PAGINA) incompleta = true;
        for (const c of busca.data.clients) {
          if (!c.idClient || c.idClient === paciente.idClient) continue;
          const k = fim8(c.whatsapp);
          if (k !== null && chaves.has(k) && nomesCompativeis(nome, c.name)) irmaos.set(c.idClient, c.name);
        }
      });
      const ids = [...irmaos.keys()];
      if (ids.length > MAX_IRMAOS) incompleta = true;
      const lidos = await Promise.all(
        ids.slice(0, MAX_IRMAOS).map(async (id) => {
          const det = await franquia.getClient(unit, id).catch((err: unknown) => {
            logger.warn({ err: String(err), idClient: id }, 'consulta-em-outro-cadastro: falha ao ler o cadastro irmão');
            return null;
          });
          return { id, det };
        }),
      );
      for (const { id, det } of lidos) {
        duplicados.push(id);
        if (!det || !det.ok) {
          incompleta = true;
          continue;
        }
        const c = det.data?.client;
        if (!c) continue;
        const dele = AgendaReconcileService.avaliacaoDePe(c.schedules, p.agoraLocal);
        if (dele) achadas.push({ idClient: id, schedule: dele });
      }
    } catch (err) {
      logger.warn({ err: String(err), idClient: paciente.idClient }, 'consulta-em-outro-cadastro: falha ao procurar os outros cadastros');
      incompleta = true;
    }
  }

  // a mais próxima; empate fica com o cadastro pedido (vem primeiro na lista)
  const consulta = [...achadas].sort((a, b) => quando(a.schedule).localeCompare(quando(b.schedule)))[0] ?? null;
  return { consulta, duplicados, incompleta };
}
