/**
 * `recuperacao_agenda`: o retorno da lista diária de recuperação (avaliação desmarcada ou faltosa), por unidade e período. SÓ LEITURA, só
 * para quem altera cartões (a lista de escritores do conector).
 *
 * Devolve, por unidade e modo («ligado» = a recepção recebeu a lista; «seco» = só no papel, ninguém recebeu): quantos entraram na lista,
 * quantos voltaram a marcar e quantos compareceram em até X dias, comparado com a base que a rede tinha ANTES da lista (11% e 3%).
 * Número só de contagem: nunca nome nem telefone. A ressalva do método (correlação, não prova) vai na própria resposta.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, diasNoPeriodo, somarDias, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';
import { hojeNoFuso } from './tempo.js';
import { prisma } from '../lib/prisma.js';
import { BASE_DA_REDE, JANELA_MAXIMA_DIAS, JANELA_PADRAO_DIAS, medirUnidade, type MedicaoDaUnidade } from '../lib/recuperacao-agenda-medicao.js';

/** Quantos dias de lista cabem numa consulta (cada unidade lê eventos de cada paciente listado). */
export const MAX_DIAS_DO_PERIODO = 120;
const PERIODO_PADRAO_DIAS = 60;

export interface DepsDaRecuperacao {
  unidades: () => Promise<Array<{ id: string; slug: string }>>;
  medir: typeof medirUnidade;
  agora?: () => Date;
}

export const depsDeProducao: DepsDaRecuperacao = {
  unidades: () => prisma.unit.findMany({ select: { id: true, slug: true } }),
  medir: medirUnidade,
};

export async function recuperacaoAgenda(
  deps: DepsDaRecuperacao,
  a: { unidade?: string; inicio?: string; fim?: string; janelaDias?: number },
): Promise<Record<string, unknown>> {
  const hoje = hojeNoFuso('America/Sao_Paulo', deps.agora?.());
  const fim = a.fim ? validarData(a.fim, 'fim') : hoje;
  const inicio = a.inicio ? validarData(a.inicio, 'inicio') : somarDias(fim, -(PERIODO_PADRAO_DIAS - 1));
  if (inicio > fim) throw new ErroDeEntrada('inicio é depois do fim');
  if (diasNoPeriodo(inicio, fim) > MAX_DIAS_DO_PERIODO) throw new ErroDeEntrada(`período de no máximo ${MAX_DIAS_DO_PERIODO} dias por consulta`);
  const janelaDias = a.janelaDias ?? JANELA_PADRAO_DIAS;
  if (!Number.isInteger(janelaDias) || janelaDias < 1 || janelaDias > JANELA_MAXIMA_DIAS) throw new ErroDeEntrada(`janelaDias: de 1 a ${JANELA_MAXIMA_DIAS} dias`);

  const todas = await deps.unidades();
  let alvo = todas;
  if (a.unidade?.trim()) {
    const slug = acharSlug(todas.map((u) => u.slug), a.unidade);
    if (!slug) throw new ErroDeEntrada(`unidade desconhecida ou ambígua: ${a.unidade}. Válidas: ${todas.map((u) => u.slug).sort().join(', ')}`);
    alvo = todas.filter((u) => u.slug === slug);
  }

  const porUnidade: MedicaoDaUnidade[] = [];
  const falhas: Array<{ unidade: string; erro: string }> = [];
  for (const u of alvo) {
    try {
      const m = await deps.medir({ unitId: u.id, slug: u.slug, inicio, fim, janelaDias, agora: deps.agora?.() });
      // sem pedir a unidade, só as que têm alguma coisa: 30 unidades «sem dado» é ruído
      if (a.unidade?.trim() || m.eventosNoHistorico > 0 || m.listas.itens > 0) porUnidade.push(m);
    } catch (e) {
      falhas.push({ unidade: u.slug, erro: e instanceof Error ? e.message.slice(0, 200) : 'falhou' });
    }
  }

  return {
    consultadoEm: (deps.agora?.() ?? new Date()).toISOString(),
    periodo: { inicio, fim },
    janelaDias,
    baseAntesDaLista: BASE_DA_REDE,
    comoLer:
      'Cada linha da lista conta uma vez («seco» e «ligado» são contados separado). «remarcaram»: depois da lista e dentro da janela apareceu agendamento novo do mesmo paciente (mesma unidade, mesmo nome) para o dia da lista ou depois, ' +
      'ou o mesmo agendamento voltou a ficar marcado para uma data de hoje em diante. «compareceram»: dos que remarcaram, quantos foram ATENDIDO. A taxa só usa quem foi listado há pelo menos a janela inteira; o resto está «em observação». ' +
      '«Desmarque» soma «desmarcou» e «desmarcou depois do horário (provável falta)»; «falta» é o NÃO COMPARECEU. ' +
      'É CORRELAÇÃO: quem voltou depois de aparecer na lista pode ter voltado sozinho, e o número não prova que a ligação causou a volta. A comparação que mais se aproxima de uma prova é «ligado» contra «seco» na mesma unidade e época (o seco é a lista que ninguém recebeu); contra a base da rede, que é um piso e de outro período, é só um indício. ' +
      'O paciente é reconhecido pelo nome (a agenda da franquia não traz o id): homônimos se misturam. «historicoDesde» é quando o histórico começou: antes disso não há dado, e «semDado» nunca é zero.',
    porUnidade,
    ...(falhas.length ? { unidadesComFalha: falhas } : {}),
  };
}

export function registrarRecuperacaoAgenda(server: McpServer, deps: DepsDaRecuperacao = depsDeProducao, auditar?: Auditar): void {
  server.registerTool(
    'recuperacao_agenda',
    {
      title: 'Recuperação de avaliações: quantos voltaram',
      description:
        'O retorno da lista diária de recuperação (avaliação desmarcada ou faltosa, para a recepção ligar): por unidade e período, quantos pacientes entraram na lista, ' +
        'quantos voltaram a marcar e quantos compareceram em até X dias (padrão 30), separando «ligado» (a recepção recebeu) de «seco» (só no papel, grupo de comparação), ' +
        'comparado com a base da rede antes da lista (11% dos desmarcados, 3% dos faltosos). Só contagem: nunca nome nem telefone. É correlação, não prova de que a ligação causou a volta: a resposta explica o método. ' +
        'Só leitura. Sem unidade, mostra as que têm histórico ou lista.',
      inputSchema: {
        unidade: z.string().optional().describe('slug ou nome curto ("acailandia"); vazio = todas as que têm dado'),
        inicio: z.string().optional().describe('primeiro dia da LISTA, AAAA-MM-DD (padrão: 60 dias atrás)'),
        fim: z.string().optional().describe('último dia da lista, AAAA-MM-DD (padrão: hoje)'),
        janelaDias: z.number().int().min(1).max(JANELA_MAXIMA_DIAS).optional().describe(`em até quantos dias depois da lista o paciente voltou a marcar (padrão ${JANELA_PADRAO_DIAS})`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('recuperacao_agenda', args, auditar, () => recuperacaoAgenda(deps, args)),
  );
}
