/**
 * As ferramentas de ESCRITA do Asaas no conector (o que o claude.ai lê): nomes, descrições em português simples, esquemas e o portão
 * de quem pode usar. A lógica está em `asaas-escrita.ts` (cliente e cobrança), `asaas-operacoes.ts` (editar, cancelar, estornar,
 * transferir) e `asaas-limites.ts` (tetos, destinos, aviso).
 *
 * Tudo DIRETO, sem passo de confirmação — por isso as travas automáticas existem: só quem está em MCP_ESCRITA_EMAILS vê estas
 * ferramentas, só nas clínicas de ASAAS_ESCRITA_UNIDADES, uma clínica por vez, com tetos por operação e por dia, lista fechada de
 * destinos para transferência e aviso no Telegram.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { asaasCobranca, type ContextoAsaas } from './asaas.js';
import { cancelarCobranca, editarCliente, editarCobranca, estornarCobranca, limitesEDestinos, transferir } from './asaas-operacoes.js';
import { criarCliente, criarCobranca, LIMITES_ASAAS, mascararPedido, recusarCamposDesconhecidos, sanear, type CtxEscrita, type EstadoEscritaAsaas, type Quem, type Registrar } from './asaas-escrita.js';
import { PADRAO_TETOS } from './asaas-limites.js';
import { executar } from './ferramenta.js';

/** `executar` com a mensagem de erro limpa (sem chave, documento ou e-mail) e os argumentos mascarados no registro. */
function executarSeguro(nome: string, argumentos: unknown, auditar: Auditar, fn: () => Promise<unknown>) {
  return executar(nome, argumentos, auditar, async () => {
    try {
      return await fn();
    } catch (e) {
      throw sanear(e);
    }
  });
}

const endereco = z.object({
  cep: z.string().describe('8 dígitos'),
  logradouro: z.string(),
  numero: z.string(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
});

const SO_QUEM_PODE =
  'Faz DIRETO, sem pedir confirmação: confira o pedido com a pessoa ANTES de chamar (clínica, cliente, valor). Só quem tem permissão de escrita vê esta ferramenta, e só nas clínicas liberadas no servidor.';
const PROIBIDO =
  'Este conector NUNCA: altera dados bancários da clínica, chaves de API, webhooks ou usuários do Asaas; faz antecipação ou empréstimo; paga contas (boleto de terceiros); recebe número de cartão pelo chat.';

export function registrarEscritaAsaas(server: McpServer, asaas: ContextoAsaas, esc: EstadoEscritaAsaas, quem: Quem, auditar: Auditar): void {
  const ctx: CtxEscrita = { asaas, esc };
  // em produção o `auditar` devolve uma promessa (true = o banco gravou); a escrita de dinheiro espera a intenção ser gravada antes de chamar o Asaas
  const registrar: Registrar = (evento, argumentos, ok, erro) => auditar({ ferramenta: evento, argumentos, ok, ms: 0, ...(erro ? { erro } : {}) });
  const unidade = z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra"). "todas" não vale para gravar.');
  const avisarCliente = z.boolean().optional().describe('o Asaas pode mandar e-mail/SMS da cobrança ao cliente? Padrão NÃO (false). Só true se a pessoa pediu.');
  const escreve = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const apaga = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const tetos = `Tetos automáticos (por chave do Asaas; veja o que vale de verdade em asaas_limites): padrão R$ ${PADRAO_TETOS.operacaoReais.toLocaleString('pt-BR')} por operação e R$ ${PADRAO_TETOS.diaReais.toLocaleString('pt-BR')} por dia, somando cobranças criadas + estornos + transferências; estorno e transferência têm teto PRÓPRIO, menor (padrão R$ ${PADRAO_TETOS.saidaOperacaoReais.toLocaleString('pt-BR')} por operação e R$ ${PADRAO_TETOS.saidaDiaReais.toLocaleString('pt-BR')} por dia, cada um). Passou do teto, recusa; quem sobe o teto é o João, no servidor.`;

  /**
   * Registra a ferramenta com o esquema `passthrough`: o SDK NÃO descarta em silêncio o campo que não existe (ex. `cardNumber`, `ccv`, `expiryMonth`);
   * ele chega aqui e o pedido inteiro é RECUSADO. No registro da auditoria, campo desconhecido entra só pelo nome, nunca pelo valor.
   */
  const tool = <S extends z.ZodRawShape>(
    nome: string,
    cfg: { title: string; description: string; inputSchema: S; annotations: Record<string, boolean> },
    fn: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    const conhecidos = Object.keys(cfg.inputSchema);
    server.registerTool(nome, { ...cfg, inputSchema: z.object(cfg.inputSchema).passthrough() }, (args: Record<string, unknown>) =>
      executarSeguro(nome, mascararPedido(args, conhecidos), auditar, async () => {
        recusarCamposDesconhecidos(args, conhecidos);
        return fn(args as z.infer<z.ZodObject<S>>);
      }),
    );
  };

  server.registerTool(
    'asaas_limites',
    {
      title: 'Limites e destinos do Asaas (clínica)',
      description:
        'Mostra, para UMA clínica com escrita liberada: os tetos (geral e próprios de estorno e de transferência, por operação e por dia, por chave do Asaas), quanto já foi usado HOJE e quanto resta, e a lista de destinos permitidos para transferência ' +
        '(vazia = transferência desligada). Consulte antes de transferir ou de uma cobrança grande. Não grava nada. ' + PROIBIDO,
      inputSchema: { unidade },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_limites', args, auditar, () => limitesEDestinos(ctx, args)),
  );
  server.registerTool(
    'asaas_cobranca',
    {
      title: 'Uma cobrança (Asaas)',
      description:
        'Uma cobrança do Asaas pelo id (pay_…) ou pela externalReference: status, valor, forma, vencimento, links para pagar e estornos. Confira aqui antes de cancelar/estornar e depois, para ver o resultado. ' +
        'Só para quem tem permissão de escrita (devolve os links de pagamento).',
      inputSchema: { unidade, cobrancaId: z.string().optional(), externalReference: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_cobranca', args, auditar, () => asaasCobranca(asaas, args)),
  );
  tool(
    'asaas_criar_cliente',
    {
      title: 'Cadastrar cliente (Asaas)',
      description:
        'CADASTRA um cliente no Asaas de UMA clínica. Confere antes se o CPF/CNPJ já existe (se existir, devolve o id e NÃO cria outro). O cliente nasce SEM aviso automático ' +
        'por e-mail/SMS, a menos que avisarCliente=true. ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        nome: z.string().min(2).max(120),
        cpfCnpj: z.string().min(11).describe('CPF (11 dígitos) ou CNPJ (14), com ou sem pontuação; os dígitos verificadores são conferidos'),
        email: z.string().optional(),
        telefone: z.string().optional().describe('DDD + número'),
        endereco: endereco.optional(),
        avisarCliente,
      },
      annotations: escreve,
    },
    (args) => criarCliente(ctx, quem, args, registrar),
  );
  tool(
    'asaas_editar_cliente',
    {
      title: 'Editar cliente (Asaas)',
      description:
        'ALTERA nome, e-mail, telefone, endereço ou o aviso automático de um cliente que já existe (clienteId = cus_…). O CPF/CNPJ não muda por aqui. Só vai o que você informar. ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        clienteId: z.string().min(4).describe('cus_… (use asaas_cliente para achar)'),
        nome: z.string().min(2).max(120).optional(),
        email: z.string().optional(),
        telefone: z.string().optional().describe('DDD + número'),
        endereco: endereco.optional(),
        avisarCliente: z.boolean().optional().describe('true liga e false desliga o e-mail/SMS automático do Asaas para este cliente'),
      },
      annotations: apaga,
    },
    (args) => editarCliente(ctx, quem, args, registrar),
  );
  tool(
    'asaas_criar_cobranca',
    {
      title: 'Criar cobrança (Asaas)',
      description:
        'CRIA uma cobrança no Asaas de UMA clínica: BOLETO (padrão), PIX ou CARTAO. Cartão sai como LINK de pagamento: o paciente digita o cartão no Asaas, NUNCA no chat ' +
        '(não passe número, validade nem CVV: é recusado). Parcelamento: parcelas de 2 a 12 em boleto ou cartão (não no Pix); "valor" é o TOTAL. ' +
        'Cliente: clienteId (cus_…) OU cpfCnpj de quem já existe; se o CPF/CNPJ não existe, passe novoCliente para cadastrar junto. ' +
        `Vencimento de hoje a +${LIMITES_ASAAS.maxDiasVencimento} dias; descrição obrigatória (aparece para o paciente, sem CPF/telefone). Informe sempre externalReference, um identificador ÚNICO desta cobrança ` +
        '(ex. nº do pedido; NÃO reutilize), para evitar duplicata. Cobrança igual em 10 minutos é recusada. Devolve o id, o link para pagar, a linha digitável (boleto) ou o Pix copia-e-cola. ' +
        `${tetos} Cobrança acima de 50% do teto avisa o João no Telegram. Se a resposta for erro de rede, NÃO repita às cegas: confira com asaas_cobranca. ` + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        clienteId: z.string().optional(),
        cpfCnpj: z.string().optional(),
        novoCliente: z.object({ nome: z.string(), email: z.string().optional(), telefone: z.string().optional(), endereco: endereco.optional() }).optional(),
        forma: z.enum(['BOLETO', 'PIX', 'CARTAO']).optional().describe('padrão BOLETO'),
        parcelas: z.number().int().min(1).max(LIMITES_ASAAS.maxParcelas).optional().describe('1 (padrão) a 12; só boleto ou cartão'),
        valor: z.number().describe('em reais, até 2 casas; no parcelado é o total'),
        vencimento: z.string().describe(`AAAA-MM-DD, de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias`),
        descricao: z.string().min(1).max(500),
        externalReference: z.string().max(100).optional(),
        avisarCliente,
      },
      annotations: escreve,
    },
    (args) => criarCobranca(ctx, quem, args, registrar),
  );
  tool(
    'asaas_editar_cobranca',
    {
      title: 'Editar cobrança pendente (Asaas)',
      description:
        'ALTERA valor, vencimento ou descrição de uma cobrança PENDENTE (aguardando pagamento) pelo id (pay_…). Cobrança já paga ou vencida não edita (cancele ou estorne). ' +
        'O valor novo conta no teto por operação; se subir, o acréscimo conta no teto do dia (reduzir não devolve espaço). ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        cobrancaId: z.string().min(4).describe('pay_… (veja o id em asaas_cobrancas ou asaas_cobranca)'),
        valor: z.number().optional(),
        vencimento: z.string().optional().describe(`AAAA-MM-DD, de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias`),
        descricao: z.string().min(1).max(500).optional(),
      },
      annotations: apaga,
    },
    (args) => editarCobranca(ctx, quem, args, registrar),
  );
  tool(
    'asaas_cancelar_cobranca',
    {
      title: 'Cancelar cobrança (Asaas)',
      description:
        'CANCELA (exclui) uma cobrança que ainda NÃO foi paga (pendente ou vencida), pelo id (pay_…). Cobrança já paga não cancela: use asaas_estornar_cobranca. Cada cancelamento avisa o João no Telegram. ' +
        'O valor cancelado NÃO devolve espaço ao teto do dia. ' + SO_QUEM_PODE,
      inputSchema: { unidade, cobrancaId: z.string().min(4).describe('pay_…') },
      annotations: apaga,
    },
    (args) => cancelarCobranca(ctx, quem, args, registrar),
  );
  tool(
    'asaas_estornar_cobranca',
    {
      title: 'Estornar cobrança recebida (Asaas)',
      description:
        'IRREVERSÍVEL — NÃO TEM VOLTA: o dinheiro sai da conta e não há como desfazer por aqui. Só use quando a pessoa pediu EXPRESSAMENTE para devolver o dinheiro de uma cobrança que o paciente JÁ PAGOU ' +
        '(RECEBIDA ou CONFIRMADA), pelo id (pay_…). Sem o pedido claro da pessoa, ou se a cobrança ainda não foi paga, NÃO use (para cobrança não paga, o caminho é asaas_cancelar_cobranca). ' +
        'Estorna o valor todo que ainda resta, ou parte dele (informe valor); estornos anteriores da mesma cobrança são descontados: nunca devolve mais do que o paciente pagou. ' +
        'Cada estorno avisa o João no Telegram. Estorno igual em 10 minutos é recusado. ' + tetos + ' ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        cobrancaId: z.string().min(4).describe('pay_…'),
        valor: z.number().optional().describe('só para estorno PARCIAL, em reais; sem isso estorna o valor todo'),
        motivo: z.string().max(140).optional().describe('texto curto, sem CPF/telefone'),
      },
      annotations: apaga,
    },
    (args) => estornarCobranca(ctx, quem, args, registrar),
  );
  tool(
    'asaas_transferir',
    {
      title: 'Transferir / Pix de saída (Asaas)',
      description:
        'IRREVERSÍVEL — NÃO TEM VOLTA: o dinheiro sai da conta da clínica e não há como desfazer por aqui. Só use quando a pessoa pediu EXPRESSAMENTE para transferir aquele valor para aquele destino, ' +
        'depois de conferir valor e destino com ela; na dúvida, pergunte antes. ' +
        'TRANSFERE dinheiro da conta Asaas da clínica (Pix de saída) SÓ para um destino que já está na lista permitida daquela clínica (veja asaas_limites). O destino é achado pela chave Pix EXATA, pela ' +
        'conta bancária EXATA ou pelo apelido; o que vai ao Asaas é o que está na lista do servidor, nunca o que for digitado aqui. Destino fora da lista é recusado, e a lista vazia deixa a ' +
        'transferência DESLIGADA. NÃO existe cadastrar destino novo pelo chat: quem coloca é o João, no servidor. Cada transferência avisa o João no Telegram (conta, valor, quem pediu, destino). ' +
        tetos + ' Transferência igual (mesmo destino, valor e descrição) em 10 minutos é recusada. ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        destino: z.string().optional().describe('chave Pix exata OU apelido do destino permitido'),
        contaBancaria: z
          .object({ banco: z.string().optional(), agencia: z.string().optional(), conta: z.string().optional(), digito: z.string().optional() })
          .optional()
          .describe('alternativa ao "destino": a conta bancária EXATA de um destino permitido'),
        valor: z.number().describe('em reais, até 2 casas'),
        descricao: z.string().max(140).optional().describe('texto curto para o extrato, sem CPF/telefone'),
      },
      annotations: apaga,
    },
    (args) => transferir(ctx, quem, args, registrar),
  );
}

/**
 * O portão de quem escreve: só quem está na lista de escrita (MCP_ESCRITA_EMAILS, já resolvida em ids) ganha as ferramentas.
 * Fora da lista elas nem existem na sessão — não aparecem e não podem ser chamadas. Devolve se registrou.
 */
export function registrarEscritaAsaasSePermitido(
  server: McpServer,
  asaas: ContextoAsaas,
  esc: EstadoEscritaAsaas,
  usuario: string,
  escritores: ReadonlySet<string>,
  auditar: Auditar,
  quem: { email?: string; clientId?: string } = {},
): boolean {
  if (!escritores.has(usuario)) return false;
  registrarEscritaAsaas(server, asaas, esc, { id: usuario, ...(quem.email ? { email: quem.email } : {}), ...(quem.clientId ? { clientId: quem.clientId } : {}) }, auditar);
  return true;
}
