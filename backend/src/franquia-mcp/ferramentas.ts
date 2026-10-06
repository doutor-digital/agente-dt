/**
 * As 11 ferramentas, com o texto que o Claude lê pra decidir qual usar. A descrição diz o que
 * a ferramenta devolve E o que ela não cobre: é isso que evita relatório errado.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as c from './consultas.js';
import type { Contexto } from './contexto.js';
import { ErroDeEntrada } from './travas.js';

const unidade = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('unidade: slug inteiro ou nome curto ("serra" acha "doutor-hernia-serra"), uma lista deles, ou "todas". Veja listar_unidades.');
const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD, no dia local da unidade`);
const id = (o: string) => z.number().int().positive().describe(o);
const saida = {
  maxItens: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .describe('registros devolvidos por unidade. Padrão: 50 com uma unidade; 0 (só totais) com várias.'),
  agruparPor: z
    .string()
    .optional()
    .describe('conta os registros por este campo (ex. "statusName", "sourceName"); "dia" = pelo dia local da data principal'),
};

const COMUM =
  ' Uma unidade com erro não derruba as outras: ela aparece com ok=false. Com várias unidades, "rede" soma só as que deram certo ' +
  'e lista as que ficaram fora. "truncado" = leitura incompleta, o total é um mínimo. Datas UTC ganham um campo "…Local" no fuso da unidade.';

/** Chamado depois de cada ferramenta: quem usa o servidor decide o que registrar (log, banco). */
export type Auditar = (registro: { ferramenta: string; argumentos: unknown; ok: boolean; ms: number; erro?: string }) => void;

export interface OpcoesFerramentas {
  auditar?: Auditar;
}

async function executar(fn: () => Promise<unknown> | unknown): Promise<{ resultado: CallToolResult; erro?: string }> {
  try {
    return { resultado: { content: [{ type: 'text', text: JSON.stringify(await fn()) }] } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const texto = e instanceof ErroDeEntrada ? `Pedido inválido: ${msg}` : msg;
    return { resultado: { isError: true, content: [{ type: 'text', text: texto }] }, erro: texto };
  }
}

export function registrarFerramentas(server: McpServer, ctx: Contexto, op: OpcoesFerramentas = {}): void {
  const responder = async (ferramenta: string, argumentos: unknown, fn: () => Promise<unknown> | unknown) => {
    const inicio = Date.now();
    const { resultado, erro } = await executar(fn);
    try {
      op.auditar?.({ ferramenta, argumentos, ok: !erro, ms: Date.now() - inicio, erro });
    } catch {
      // auditoria que falha não pode derrubar a resposta
    }
    return resultado;
  };

  server.registerTool(
    'listar_unidades',
    {
      title: 'Unidades configuradas',
      description: 'Lista as unidades da franquia que este MCP consegue ler (slug, nome, fuso). Não chama a franquia.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => responder('listar_unidades', {}, () => c.listarUnidades(ctx)),
  );

  server.registerTool(
    'checar_conexao',
    {
      title: 'Testar tokens',
      description:
        'Testa o token de cada unidade (1 busca mínima por unidade), mostra a versão da API e quantas chamadas este MCP ' +
        'já fez desde que subiu, por unidade e endpoint. Use pra diagnosticar 401/403 antes de um relatório.',
      inputSchema: { unidade },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('checar_conexao', args, () => c.checarConexao(ctx, args)),
  );

  server.registerTool(
    'buscar_pacientes',
    {
      title: 'Pacientes (clientes) da franquia',
      description:
        'Busca pacientes (clientes) no CRM da franquia. Filtros aceitos pela franquia: nome (parcial, mín. 2 letras), idClient, idStatus. ' +
        'NÃO filtra por telefone, e-mail, data ou origem (a franquia ignora). O WhatsApp volta também como "whatsappE164" (+55…).' +
        COMUM,
      inputSchema: { unidade, nome: z.string().optional(), idClient: id('id do paciente').optional(), idStatus: id('id do status').optional(), ...saida },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('buscar_pacientes', args, () => c.buscarPacientes(ctx, args)),
  );

  server.registerTool(
    'paciente_por_id',
    {
      title: 'Ficha de um paciente',
      description: 'Ficha completa de UM paciente pelo idClient, em UMA unidade (histórico de consultas, sessões e tratamento, quando a franquia manda).',
      inputSchema: { unidade: z.string().min(1).describe('slug de uma unidade'), idClient: id('id do paciente na franquia') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('paciente_por_id', args, () => c.pacientePorId(ctx, args)),
  );

  server.registerTool(
    'buscar_leads',
    {
      title: 'Leads da franquia',
      description:
        'Leads cadastrados no CRM da franquia (lead ≠ paciente: vira paciente quando é convertido). inicio/fim filtram pela DATA DE CRIAÇÃO. ' +
        'Sem período, traz todos (até o teto de páginas).' +
        COMUM,
      inputSchema: {
        unidade,
        inicio: data('início do período de criação').optional(),
        fim: data('fim do período de criação, incluso').optional(),
        nome: z.string().optional(),
        idSource: id('id da origem (veja dados_gerais lista=sources)').optional(),
        idCategory: id('id da categoria do lead').optional(),
        ...saida,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('buscar_leads', args, () => c.buscarLeads(ctx, args)),
  );

  server.registerTool(
    'buscar_agendamentos',
    {
      title: 'Agenda da franquia',
      description:
        'Agendamentos de TODOS os status (agendado, confirmado, atendido, faltou, desmarcado, remarcado…), filtrados pela DATA DA CONSULTA ' +
        '(não pela de criação — o guia da franquia está errado nisso). Use agruparPor="statusName" pra contar comparecimento e falta. ' +
        'Inclui sessões de tratamento, não só avaliações: separe por categoryName se precisar.' +
        COMUM,
      inputSchema: {
        unidade,
        inicio: data('primeiro dia da agenda'),
        fim: data('último dia da agenda, incluso'),
        nome: z.string().optional().describe('nome do paciente, parcial, mín. 2 letras'),
        idCategory: id('id da categoria do agendamento (veja dados_gerais lista=schedules/categories)').optional(),
        ...saida,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('buscar_agendamentos', args, () => c.buscarAgendamentos(ctx, args)),
  );

  server.registerTool(
    'buscar_tratamentos',
    {
      title: 'Tratamentos da franquia',
      description:
        'Tratamentos (pacotes de fisioterapia/cirurgia) filtrados pela DATA DE CRIAÇÃO do tratamento. Período obrigatório: sem ele a ' +
        'franquia aplica sozinha o mês corrente e o relatório sai cortado. Telefone não vem aqui (use paciente_por_id).' +
        COMUM,
      inputSchema: {
        unidade,
        inicio: data('início do período de criação'),
        fim: data('fim do período de criação, incluso'),
        nome: z.string().optional(),
        idStatus: id('id do status (veja dados_gerais lista=treatments/status)').optional(),
        idCategory: id('2 = Fisioterapia, 4 = Cirurgia').optional(),
        idStaff: id('id do profissional').optional(),
        ...saida,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('buscar_tratamentos', args, () => c.buscarTratamentos(ctx, args)),
  );

  const periodoBi = { unidade, inicio: data('início do período'), fim: data('fim do período, incluso') };
  const notaBi =
    ' Número oficial da franquia, com cache de 6 h (a franquia pede BI no máximo 1–2 vezes por dia). Períodos longos são somados em fatias de 90 dias. ' +
    'Muitos tokens ainda não têm permissão de BI: 403 aparece como ok=false naquela unidade.';

  server.registerTool(
    'bi_leads_por_origem',
    {
      title: 'BI: leads por origem',
      description: 'Quantos leads entraram por origem (Site, Instagram, IA SOFIA…) no período.' + notaBi,
      inputSchema: periodoBi,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('bi_leads_por_origem', args, () => c.bi(ctx, c.BI.leadsPorOrigem, args)),
  );

  server.registerTool(
    'bi_pacientes_por_genero',
    {
      title: 'BI: pacientes por gênero',
      description: 'Pacientes por gênero e idade média no período (idade média ponderada entre fatias).' + notaBi,
      inputSchema: periodoBi,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('bi_pacientes_por_genero', args, () => c.bi(ctx, c.BI.pacientesPorGenero, args)),
  );

  server.registerTool(
    'bi_tratamentos_por_categoria',
    {
      title: 'BI: tratamentos por categoria',
      description: 'Tratamentos por categoria (Fisioterapia, Cirurgia…) no período.' + notaBi,
      inputSchema: periodoBi,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('bi_tratamentos_por_categoria', args, () => c.bi(ctx, c.BI.tratamentosPorCategoria, args)),
  );

  server.registerTool(
    'dados_gerais',
    {
      title: 'Cadastros de configuração',
      description:
        'Listas de configuração da unidade (origens, status, categorias, profissionais/locais de tratamento, formas de pagamento…). ' +
        'Serve pra traduzir os ids das outras ferramentas em nomes. Cache de 24 h.',
      inputSchema: { unidade, lista: z.enum(c.LISTAS_GERAIS) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => responder('dados_gerais', args, () => c.dadosGerais(ctx, args)),
  );
}
