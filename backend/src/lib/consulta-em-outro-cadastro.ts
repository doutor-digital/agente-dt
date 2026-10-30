/**
 * "Esse paciente já tem consulta de pé — em QUALQUER cadastro dele na franquia?"
 *
 * Caso Ana Christina (Timbó, 29/10/2026): a IA usava o cadastro 374228. A recepção criou OUTRO cadastro da mesma
 * paciente (374234, mesmo nome e telefone) e marcou nele sexta 16:00. Na hora em que a paciente disse "ok, obrigada", a
 * IA tentou marcar 16:00 no 374228, a franquia disse "ocupado" (pela consulta da própria paciente) e a IA ofereceu
 * outro horário a quem já estava marcada. A proteção do caso Bebedouro (21/10) só olhava a agenda do idClient que a IA
 * passou — com cadastro em dobro ela nunca via a consulta.
 *
 * Aqui a pergunta é por PESSOA: o cadastro pedido + os outros cadastros com o mesmo telefone (8 últimos dígitos). A
 * franquia não busca por telefone (`/clients/search` ignora o parâmetro), então a busca é por NOME — nos mesmos termos do
 * widget (`termosDeBusca`: nome inteiro, "primeiro último", só o primeiro: a recepção escreve o nome de outro jeito) — e o
 * telefone filtra o resultado. Nada aqui grava coisa nenhuma: só lê.
 *
 * Dois graus de certeza, porque mãe e filha dividem o mesmo WhatsApp e o nome "compatível" não prova que é a mesma pessoa
 * ("Maria Eduarda da Silva" × "Maria José da Silva", "José Carlos Pereira" × "... Júnior", "Ana" × "Ana Paula Costa"):
 *  - MESMO paciente = telefone igual E nome normalizado IGUAL (`nomeDaFranquia`: maiúsculas, sem acento, espaços colapsados).
 *    Só estes entram em `consulta`/`duplicados` — quem chama pode recusar "já tem consulta" e revincular o cartão a eles.
 *  - POSSÍVEL duplicado = telefone igual e nome só compatível (inclui "Christina" × "Cristina"). Não prova nada: vai em
 *    `possiveisDuplicados`, com a consulta de pé dele (se houver), só para a equipe conferir. Ninguém usa o cadastro dele.
 *
 * `incompleta` é a resposta honesta de "não consegui ver tudo" (a busca ou a leitura de algum cadastro falhou): quem chama
 * NÃO pode tratar a falta de consulta como prova de que não há.
 */
import type { Unit } from '@prisma/client';
import { SpineService, type SpineSchedule } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { nomesCompativeis } from './casamento-jornada.js';
import { nomeDaFranquia } from './franquia-sync.js';
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

export interface PossivelDuplicado {
  idClient: number;
  name: string | null;
  /** a consulta de pé dele, se a leitura mostrou uma; `null` = nenhuma vista */
  consulta: ConsultaDePe | null;
}

export interface ConferenciaDeCadastros {
  /** a consulta de pé mais próxima entre os cadastros da MESMA pessoa (o pedido incluído); `null` = nenhuma vista */
  consulta: ConsultaDePe | null;
  /** os OUTROS cadastros da mesma pessoa (mesmo telefone, nome normalizado igual) */
  duplicados: number[];
  /** mesmo telefone e nome só compatível: talvez a mesma pessoa, talvez a mãe/filha. NÃO é para usar nem revincular */
  possiveisDuplicados: PossivelDuplicado[];
  /** algo falhou (busca, página cheia ou leitura de um cadastro): "nenhuma consulta" NÃO está provado */
  incompleta: boolean;
}

/** PURA. Mesmo nome, no sentido da franquia: maiúsculas, sem acento, espaços colapsados. Nome vazio nunca é igual. */
export function mesmoNome(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = nomeDaFranquia(a);
  return na !== '' && na === nomeDaFranquia(b);
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
  // O próprio cadastro já mostra a consulta (Bebedouro): é a resposta. Procurar irmãos gastaria chamadas à franquia à toa.
  if (propria) {
    return { consulta: { idClient: paciente.idClient, schedule: propria }, duplicados: [], possiveisDuplicados: [], incompleta: false };
  }
  const achadas: ConsultaDePe[] = [];
  const duplicados: number[] = [];
  const possiveisDuplicados: PossivelDuplicado[] = [];
  let incompleta = false;

  const chaves = new Set(
    [paciente.whatsapp, ...p.fones].map(fim8).filter((x): x is string => x !== null),
  );
  const nome = paciente.name?.trim() ?? '';
  // sem telefone ou sem nome não há como provar que outro cadastro é a MESMA pessoa: não se procura (e não se chuta)
  if (chaves.size > 0 && nome) {
    try {
      // a franquia prefixa «IA-»/«N-» no nome de quem nasceu pela IA ou pelo n8n; a recepção escreve sem o prefixo, e a busca é por texto
      const semPrefixo = nome.replace(/^(IA|N)-\s*/i, '').trim() || nome;
      const termos = termosDeBusca(semPrefixo, semPrefixo);
      const buscas = await Promise.all(termos.map((t) => franquia.searchClients(unit, t, POR_PAGINA).catch(() => null)));
      const iguais = new Set<number>();
      const parecidos = new Set<number>();
      const nomes = new Map<number, string | null>();
      buscas.forEach((busca, i) => {
        // o termo LARGO (só o primeiro nome, num nome de mais de uma palavra) é só uma rede a mais: se ele falha, os termos
        // específicos já responderam. Falha de um termo específico, não: era talvez justamente o que acharia o irmão
        const largo = i > 0 && !termos[i].includes(' ');
        if (!busca?.ok || !busca.data) {
          if (!largo) incompleta = true;
          return;
        }
        // página cheia no nome INTEIRO = pode haver mais gente com esse nome do que veio; nos termos largos ("Ana") a página
        // cheia é o normal e o telefone é quem decide
        if (i === 0 && busca.data.clients.length >= POR_PAGINA) incompleta = true;
        for (const c of busca.data.clients) {
          if (!c.idClient || c.idClient === paciente.idClient) continue;
          const k = fim8(c.whatsapp);
          if (k === null || !chaves.has(k)) continue;
          if (mesmoNome(nome, c.name)) iguais.add(c.idClient);
          else if (nomesCompativeis(nome, c.name)) parecidos.add(c.idClient);
          else continue;
          nomes.set(c.idClient, c.name);
        }
      });
      for (const id of iguais) parecidos.delete(id); // o mesmo cadastro achado por dois termos: vale o grau mais forte
      const ids = [...iguais, ...parecidos];
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
        const mesmo = iguais.has(id);
        if (mesmo) duplicados.push(id);
        const c = det?.ok ? det.data?.client ?? null : null;
        const dele = c ? AgendaReconcileService.avaliacaoDePe(c.schedules, p.agoraLocal) : null;
        const consulta = dele ? { idClient: id, schedule: dele } : null;
        if (mesmo) {
          if (consulta) achadas.push(consulta);
        } else {
          possiveisDuplicados.push({ idClient: id, name: nomes.get(id) ?? null, consulta });
        }
        if (!det || !det.ok) incompleta = true;
      }
    } catch (err) {
      logger.warn({ err: String(err), idClient: paciente.idClient }, 'consulta-em-outro-cadastro: falha ao procurar os outros cadastros');
      incompleta = true;
    }
  }

  // a mais próxima; empate fica com o primeiro lido
  const consulta = [...achadas].sort((a, b) => quando(a.schedule).localeCompare(quando(b.schedule)))[0] ?? null;
  return { consulta, duplicados, possiveisDuplicados, incompleta };
}
