/**
 * Campanhas de disparo que o placar acompanha. Campanha nova = um item aqui: as etiquetas dizem quem
 * recebeu, e cada dia de envio é um grupo próprio (Dia 1, Dia 2…), descoberto pelo nome da etiqueta.
 */
import type { RegraDeGrupo } from './metricas.js';

export interface Campanha {
  id: string;
  nome: string;
  /** Dia do 1º envio (YYYY-MM-DD). Eventos e agenda são lidos a partir daqui. */
  inicio: string;
  /** Até quando um agendamento conta como resultado da campanha. */
  fim: string;
  /** Texto comum às etiquetas da campanha: a busca de etiquetas do Kommo usa ele, e o filtro fino é o de `grupos`. */
  buscaDeEtiquetas: string;
  /** Unidade principal de cada conta do Kommo (a do comercial; a do resgate da mesma conta entra junto). */
  unidades: string[];
  grupos: RegraDeGrupo[];
}

export const CAMPANHAS: Campanha[] = [
  {
    id: 'outubro-rosa-2026',
    nome: 'Outubro Rosa',
    inicio: '2026-10-13',
    fim: '2026-10-31',
    buscaDeEtiquetas: 'Outubro Rosa',
    unidades: [
      'doutor-hernia-araguaina',
      'doutor-hernia-maraba',
      'doutor-hernia-parauapebas',
      'doutor-hernia-imperatriz',
      'doutor-hernia-balsas',
      'doutor-hernia-canaa',
      'doutor-hernia-porto',
      'doutor-hernia-acailandia',
      'doutor-hernia-rioverde',
    ],
    grupos: [
      {
        // 13 e 14/10: a lista de 08/10 não conferiu a agenda na hora do envio. O corte é o idSchedule das
        // avaliações criadas na manhã de 13/10 (3757439 já existia às 8h; 3758826 foi criada às 10h49).
        padrao: /^Outubro Rosa · Onda [123]$/,
        grupo: () => ({ chave: 'rodada-1', rotulo: '1ª rodada (13–14/10)', ordem: 0, agendamentoAcimaDe: 3758000 }),
      },
      {
        padrao: /^Outubro Rosa · Dia (\d+)$/,
        grupo: (m) => ({ chave: `dia-${m[1]}`, rotulo: `Dia ${m[1]}`, ordem: Number(m[1]) }),
      },
    ],
  },
];

export function campanhaPorId(id: string): Campanha | null {
  return CAMPANHAS.find((c) => c.id === id) ?? null;
}
