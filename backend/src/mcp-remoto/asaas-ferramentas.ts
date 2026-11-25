/**
 * As ferramentas de ESCRITA do Asaas no conector (o que o claude.ai lê): nomes, descrições em português simples, esquemas e o portão
 * de quem pode usar. A lógica está em `asaas-escrita.ts` (cliente e cobrança), `asaas-operacoes.ts` (editar, cancelar, estornar,
 * transferir) e `asaas-limites.ts` (tetos, destinos, aviso).
 *
 * Tudo DIRETO, sem passo de confirmação (a exceção é a NOTA FISCAL, em dois passos: `registrarNotasFiscaisAsaas`, mais abaixo) — por isso as travas automáticas existem: só quem está em MCP_ESCRITA_EMAILS vê estas
 * ferramentas, só nas clínicas de ASAAS_ESCRITA_UNIDADES, uma clínica por vez, com tetos por operação e por dia, lista fechada de
 * destinos para transferência e aviso no Telegram.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { asaasCobranca, type ContextoAsaas } from './asaas.js';
import { cancelarCobranca, editarCliente, editarCobranca, estornarCobranca, limitesEDestinos, transferir } from './asaas-operacoes.js';
import { contaDeEscrita, criarCliente, criarCobranca, LIMITES_ASAAS, mascararPedido, recusarCamposDesconhecidos, sanear, type CtxEscrita, type EstadoEscritaAsaas, type Quem, type Registrar } from './asaas-escrita.js';
import { PADRAO_TETOS } from './asaas-limites.js';
import { asaasAssinaturas, cancelarAssinatura, CICLOS, criarAssinatura, editarAssinatura, type PedidoDeAssinatura } from './asaas-assinaturas.js';
import { asaasNota, asaasNotas, STATUS_DO_FILTRO } from './asaas-notas.js';
import { confirmarNota, MAX_DIAS_EMISSAO, prepararNota, type PedidoDePreparo } from './asaas-notas-escrita.js';
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
const SO_QUEM_PODE_NOTA =
  'Só quem tem permissão de escrita vê esta ferramenta, e só nas clínicas liberadas no servidor para escrita (ASAAS_ESCRITA_UNIDADES) E ligadas para nota fiscal (ASAAS_NOTAS_UNIDADES; fora dela responde que a nota não está ligada), uma clínica por vez.';
const PROIBIDO =
  'Este conector NUNCA: altera dados bancários da clínica, chaves de API, webhooks ou usuários do Asaas; faz antecipação ou empréstimo; paga contas (boleto de terceiros); recebe número de cartão pelo chat.';

/**
 * Registra a ferramenta com o esquema `passthrough`: o SDK NÃO descarta em silêncio o campo que não existe (ex. `cardNumber`, `ccv`, `expiryMonth`);
 * ele chega aqui e o pedido inteiro é RECUSADO. No registro da auditoria, campo desconhecido entra só pelo nome, nunca pelo valor.
 */
function ferramentaSegura(server: McpServer, auditar: Auditar) {
  return <S extends z.ZodRawShape>(
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
}

export function registrarEscritaAsaas(server: McpServer, asaas: ContextoAsaas, esc: EstadoEscritaAsaas, quem: Quem, auditar: Auditar): void {
  const ctx: CtxEscrita = { asaas, esc };
  // em produção o `auditar` devolve uma promessa (true = o banco gravou); a escrita de dinheiro espera a intenção ser gravada antes de chamar o Asaas
  const registrar: Registrar = (evento, argumentos, ok, erro) => auditar({ ferramenta: evento, argumentos, ok, ms: 0, ...(erro ? { erro } : {}) });
  const unidade = z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra"). "todas" não vale para gravar.');
  const avisarCliente = z.boolean().optional().describe('o Asaas pode mandar e-mail/SMS da cobrança ao cliente? Padrão NÃO (false). Só true se a pessoa pediu.');
  const escreve = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  const apaga = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const tetos = `Tetos automáticos (por chave do Asaas; veja o que vale de verdade em asaas_limites): padrão R$ ${PADRAO_TETOS.operacaoReais.toLocaleString('pt-BR')} por operação e R$ ${PADRAO_TETOS.diaReais.toLocaleString('pt-BR')} por dia, somando cobranças criadas + estornos + transferências; estorno e transferência têm teto PRÓPRIO, menor (padrão R$ ${PADRAO_TETOS.saidaOperacaoReais.toLocaleString('pt-BR')} por operação e R$ ${PADRAO_TETOS.saidaDiaReais.toLocaleString('pt-BR')} por dia, cada um). Passou do teto, recusa; quem sobe o teto é o João, no servidor.`;

  const tool = ferramentaSegura(server, auditar);

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
    (args) =>
      executarSeguro('asaas_cobranca', args, auditar, async () => {
        // só nas clínicas com a escrita liberada (é ferramenta de quem escreve; os links de pagamento não saem de clínica desligada)
        contaDeEscrita(asaas, esc, args.unidade);
        return asaasCobranca(asaas, args);
      }),
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
        'CANCELA (exclui) uma cobrança que ainda NÃO foi paga (pendente ou vencida), pelo id (pay_…). Cobrança já paga não cancela: use asaas_estornar_cobranca. Cada cancelamento avisa o João no Telegram, e há limite de quantidade por hora (padrão 10 por chave do Asaas): cancelar é irreversível. ' +
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
        tetos + ' Transferência igual (mesmo destino e mesmo valor, mesmo que a descrição mude) em 10 minutos é recusada. ' + SO_QUEM_PODE,
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

  // ----------------------------------------------------------------- assinaturas (cobrança recorrente)
  const formaAssinatura = z.enum(['BOLETO', 'PIX', 'CARTAO', 'CLIENTE_ESCOLHE']);
  const ciclo = z.enum(CICLOS as unknown as [string, ...string[]]);
  server.registerTool(
    'asaas_assinaturas',
    {
      title: 'Assinaturas / cobranças recorrentes (Asaas)',
      description:
        'Lista as ASSINATURAS (cobrança recorrente) de UMA clínica: de um cliente (clienteId cus_… ou cpfCnpj), por status (ATIVA, INATIVA, ENCERRADA) ou todas (até 50). ' +
        'Com assinaturaId (sub_…) traz a assinatura completa e as cobranças que ela já gerou (status, vencimento e link para pagar). Use para conferir antes de editar/cancelar e depois de criar. ' +
        'Não grava nada. Só para quem tem permissão de escrita (devolve os links de pagamento).',
      inputSchema: {
        unidade,
        assinaturaId: z.string().optional().describe('sub_…'),
        clienteId: z.string().optional().describe('cus_…'),
        cpfCnpj: z.string().optional(),
        status: z.string().optional().describe('ATIVA, INATIVA ou ENCERRADA'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_assinaturas', mascararPedido(args), auditar, () => asaasAssinaturas(ctx, args)),
  );
  tool(
    'asaas_criar_assinatura',
    {
      title: 'Criar assinatura / cobrança recorrente (Asaas)',
      description:
        'CRIA uma ASSINATURA (cobrança recorrente) no Asaas de UMA clínica: o Asaas gera uma cobrança a cada ciclo (MENSAL é o padrão), começando em primeiroVencimento ' +
        `(de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias; se for hoje, a 1ª cobrança já nasce vencendo hoje). "valor" é o de CADA cobrança (a mensalidade), não o total. ` +
        'Forma: BOLETO (padrão), PIX, CARTAO (link de pagamento: o cliente digita o cartão no Asaas, NUNCA no chat) ou CLIENTE_ESCOLHE (o cliente escolhe boleto, Pix ou cartão ao pagar). ' +
        'Cliente: só quem JÁ está cadastrado, por clienteId (cus_…) OU cpfCnpj (cadastrar é asaas_criar_cliente). Se o cliente já tem assinatura ATIVA com o mesmo valor e ciclo, recusa ' +
        '(segunda de propósito: permitirOutraIgual=true). Descrição obrigatória (aparece para o cliente, sem CPF/telefone). ' +
        `A mensalidade conta como uma cobrança nos tetos: ${tetos} Assinatura igual em 10 minutos é recusada. Cada assinatura criada avisa o João no Telegram. ` +
        'Devolve o id (sub_…) e, quando o Asaas já gerou, a 1ª cobrança com o link para pagar. Se a resposta for erro de rede, NÃO repita às cegas: confira com asaas_assinaturas. ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        clienteId: z.string().optional().describe('cus_… (use asaas_cliente para achar)'),
        cpfCnpj: z.string().optional().describe('alternativa ao clienteId: o CPF/CNPJ de um cliente já cadastrado'),
        valor: z.number().describe('valor de CADA cobrança, em reais, até 2 casas'),
        ciclo: ciclo.optional().describe('padrão MENSAL'),
        primeiroVencimento: z.string().describe(`AAAA-MM-DD, de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias; o dia do mês se repete nos próximos vencimentos`),
        descricao: z.string().min(1).max(500),
        forma: formaAssinatura.optional().describe('padrão BOLETO; CLIENTE_ESCOLHE = boleto, Pix ou cartão, à escolha do cliente'),
        externalReference: z.string().max(100).optional().describe('identificador seu desta assinatura (ex. nº do contrato)'),
        avisarCliente,
        permitirOutraIgual: z.boolean().optional().describe('só true se a pessoa confirmou que quer uma SEGUNDA assinatura igual para o mesmo cliente'),
      },
      annotations: escreve,
    },
    (args) => criarAssinatura(ctx, quem, args as PedidoDeAssinatura, registrar),
  );
  tool(
    'asaas_editar_assinatura',
    {
      title: 'Editar assinatura (Asaas)',
      description:
        'ALTERA uma assinatura pelo id (sub_…): valor, próximo vencimento, descrição, forma ou ciclo. Só vai o que você informar. Por padrão vale para as PRÓXIMAS cobranças; ' +
        'atualizarCobrancasPendentes=true muda também as já geradas e ainda não pagas. Se o valor subir, o acréscimo conta no teto do dia. Cada edição avisa o João no Telegram. ' + SO_QUEM_PODE,
      inputSchema: {
        unidade,
        assinaturaId: z.string().min(4).describe('sub_… (veja em asaas_assinaturas)'),
        valor: z.number().optional().describe('novo valor de CADA cobrança'),
        proximoVencimento: z.string().optional().describe(`AAAA-MM-DD, de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias`),
        descricao: z.string().min(1).max(500).optional(),
        forma: formaAssinatura.optional(),
        ciclo: ciclo.optional(),
        atualizarCobrancasPendentes: z.boolean().optional().describe('padrão false; true = as cobranças já geradas e não pagas também mudam'),
      },
      annotations: apaga,
    },
    (args) => editarAssinatura(ctx, quem, args, registrar),
  );
  tool(
    'asaas_cancelar_assinatura',
    {
      title: 'Cancelar assinatura (Asaas)',
      description:
        'CANCELA uma assinatura pelo id (sub_…): não sai mais cobrança nova, e o Asaas APAGA junto as cobranças dela ainda não pagas (as pagas ficam; para devolver dinheiro, asaas_estornar_cobranca). ' +
        'Irreversível: para voltar, crie outra assinatura. Entra no limite de cancelamentos por hora e avisa o João no Telegram. ' + SO_QUEM_PODE,
      inputSchema: { unidade, assinaturaId: z.string().min(4).describe('sub_…') },
      annotations: apaga,
    },
    (args) => cancelarAssinatura(ctx, quem, args, registrar),
  );
}

/**
 * Nota fiscal (NFS-e): a ESCRITA em DOIS passos, diferente do resto do Asaas (que é direto). Preparar mostra o resumo e devolve um código;
 * só o confirmar, com o ok da pessoa, chama o Asaas. Também só para quem escreve: as leituras que trazem o link do PDF/XML (asaas_notas, asaas_nota). A lógica de leitura está em `asaas-notas.ts` (e asaas_dados_fiscais, liberada a quem tem o Asaas, é registrada lá).
 */
export function registrarNotasFiscaisAsaas(server: McpServer, asaas: ContextoAsaas, esc: EstadoEscritaAsaas, quem: Quem, auditar: Auditar): void {
  const ctx: CtxEscrita = { asaas, esc };
  const registrar: Registrar = (evento, argumentos, ok, erro) => auditar({ ferramenta: evento, argumentos, ok, ms: 0, ...(erro ? { erro } : {}) });
  const tool = ferramentaSegura(server, auditar);
  // as duas leituras que trazem o link do PDF/XML (CPF, endereço e serviço do paciente) só existem para quem escreve, e só nas clínicas liberadas, como asaas_cobranca
  const umaUnidade = z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra")');
  const dia = (o: string) => z.string().optional().describe(`${o}, AAAA-MM-DD`);
  server.registerTool(
    'asaas_notas',
    {
      title: 'Notas fiscais de serviço (Asaas)',
      description:
        'Notas fiscais de serviço (NFS-e) do Asaas de UMA clínica, com filtro por período (data de EMISSÃO), status, cobrança (pay_…), cliente (cus_…) ou referência. ' +
        'Devolve número, status em português, valor, data, tomador, descrição curta e os links do PDF e do XML quando a nota já foi emitida; mais o total por status. ' +
        'É preciso ao menos um filtro. Status: SCHEDULED (agendada), SYNCHRONIZED (enviada à prefeitura), AUTHORIZED (emitida), PROCESSING_CANCELLATION, CANCELED, CANCELLATION_DENIED, ERROR. ' +
        'Para saber se a clínica PODE emitir, use asaas_dados_fiscais. Só leitura: emitir e cancelar são asaas_preparar_nota → asaas_confirmar_nota. ' +
        'Só para quem tem permissão de escrita (o link do PDF/XML mostra CPF, endereço e o serviço do paciente).',
      inputSchema: {
        unidade: umaUnidade,
        inicio: dia('início do período de emissão'),
        fim: dia('fim do período de emissão'),
        status: z.enum(STATUS_DO_FILTRO).optional(),
        cobrancaId: z.string().optional().describe('notas desta cobrança (pay_…)'),
        clienteId: z.string().optional().describe('notas deste cliente/tomador (cus_…)'),
        referencia: z.string().optional().describe('externalReference da nota'),
        maxItens: z.number().int().min(0).max(100).optional().describe('notas detalhadas na resposta (padrão 30); o total e o resumo por status contam todas'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      executarSeguro('asaas_notas', args, auditar, async () => {
        contaDeEscrita(asaas, esc, args.unidade);
        return asaasNotas(asaas, args);
      }),
  );
  server.registerTool(
    'asaas_nota',
    {
      title: 'Uma nota fiscal (Asaas)',
      description:
        'Uma nota fiscal de serviço pelo id (inv_…), completa: número, status e o motivo (se deu erro), valor, deduções, data, tomador, serviço municipal, descrição, observações, ' +
        'impostos e retenções, RPS, código de verificação e os links do PDF e do XML. Use para conferir o resultado depois de emitir ou cancelar. ' +
        'Só para quem tem permissão de escrita (o link do PDF/XML mostra CPF, endereço e o serviço do paciente).',
      inputSchema: { unidade: umaUnidade, notaId: z.string().min(4).describe('inv_…') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      executarSeguro('asaas_nota', args, auditar, async () => {
        contaDeEscrita(asaas, esc, args.unidade);
        return asaasNota(asaas, args);
      }),
  );
  const aliquota = (o: string) => z.number().min(0).max(100).optional().describe(`${o}, em % (ex. 2 ou 2.5)`);
  tool(
    'asaas_preparar_nota',
    {
      title: 'Preparar nota fiscal: emitir ou cancelar (Asaas)',
      description:
        'PASSO 1 de 2 para EMITIR ou CANCELAR uma nota fiscal de serviço (NFS-e) de UMA clínica. NÃO emite nem cancela nada: confere tudo no Asaas e devolve o resumo COMPLETO (clínica, tomador, valor, deduções, serviço municipal, ' +
        'impostos e de onde veio cada um, descrição, data de emissão), os avisos (nota repetida da mesma cobrança, tomador sem endereço…) e um código. MOSTRE o resumo inteiro à pessoa e só chame asaas_confirmar_nota se ela aprovar. ' +
        'acao="emitir": informe cobrancaId (pay_…) OU clienteId (cus_…, nota avulsa); "servico" (id, código ou parte do nome do serviço municipal; veja asaas_dados_fiscais); a data (dataEmissao para AGENDAR, ou emitirAgora=true para emitir hoje); ' +
        'e os impostos em "impostos": retemIss, inss e ir SEMPRE (0 se não há), iss (se a prefeitura não traz a alíquota), e pis/cofins/csll (0 automático no Simples Nacional). ' +
        'NUNCA suponha alíquota, retenção ou serviço: o que a pessoa não disse, PERGUNTE (ou à contabilidade); o conector recusa e diz o que falta. Clínica sem dados fiscais no Asaas: recusa. ' +
        'valor e descricao saem da cobrança se não vierem. acao="cancelar": informe só notaId (inv_…); o cancelamento de nota JÁ EMITIDA depende do prazo e das regras da prefeitura e pode ser negado. ' +
        'O código vale 15 minutos, uma vez, só para quem preparou. ' + SO_QUEM_PODE_NOTA,
      inputSchema: {
        unidade: z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra"). "todas" não vale.'),
        acao: z.enum(['emitir', 'cancelar']),
        cobrancaId: z.string().optional().describe('emitir: a cobrança (pay_…) que a nota fatura'),
        clienteId: z.string().optional().describe('emitir: nota avulsa para este cliente/tomador (cus_…)'),
        valor: z.number().optional().describe('emitir: valor da nota em reais; sem isso usa o da cobrança (obrigatório na nota avulsa)'),
        deducoes: z.number().optional().describe('emitir: deduções em reais (não mudam o valor da nota, reduzem a base do ISS); padrão 0'),
        servico: z.string().optional().describe('emitir: serviço municipal — id, código (ex. 4.01) ou parte do nome. Sem lista na prefeitura (Portal Nacional): o CÓDIGO'),
        nomeDoServico: z.string().max(200).optional().describe('emitir: só quando a conta não tem lista de serviços; o nome que acompanha o código'),
        descricao: z.string().max(500).optional().describe('emitir: descrição dos serviços que sai na nota (sem CPF/telefone); sem isso usa a da cobrança'),
        observacoes: z.string().max(500).optional().describe('emitir: observações da nota'),
        dataEmissao: z.string().optional().describe(`emitir: AAAA-MM-DD, de hoje até ${MAX_DIAS_EMISSAO} dias (nota AGENDADA)`),
        emitirAgora: z.boolean().optional().describe('emitir: true = agenda para hoje e já pede a emissão à prefeitura'),
        impostos: z
          .object({
            retemIss: z.boolean().optional().describe('o tomador retém o ISS?'),
            iss: aliquota('alíquota do ISS (sem isso, vale a cadastrada na prefeitura para o serviço)'),
            pis: aliquota('PIS (no Simples Nacional é 0 e não se informa)'),
            cofins: aliquota('COFINS (no Simples Nacional é 0 e não se informa)'),
            csll: aliquota('CSLL (no Simples Nacional é 0 e não se informa)'),
            inss: aliquota('INSS'),
            ir: aliquota('IR'),
          })
          .strict()
          .optional(),
        notaId: z.string().optional().describe('cancelar: a nota (inv_…); veja asaas_notas'),
      },
      // não é "só leitura": guarda o pedido e o código que depois autoriza uma escrita fiscal; o cliente não deve aprová-la sozinho como se fosse consulta
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => prepararNota(ctx, quem, args as PedidoDePreparo),
  );
  tool(
    'asaas_confirmar_nota',
    {
      title: 'Confirmar nota fiscal: emitir ou cancelar (Asaas)',
      description:
        'PASSO 2 de 2: é AQUI que a nota é agendada/emitida (ou cancelada) no Asaas, com o código que asaas_preparar_nota devolveu. Só chame depois que a pessoa aprovou o resumo COMPLETO. ' +
        'O código vale 15 minutos, UMA vez, e só para quem preparou; se apareceu outra nota da mesma origem (ou a nota mudou de status) desde o resumo, recusa. ' +
        'Emitir e cancelar avisam o João no Telegram e ficam registrados. A prefeitura é quem autoriza: confira o resultado com asaas_nota. Se a resposta for erro de rede, NÃO repita às cegas: confira com asaas_notas. ' + SO_QUEM_PODE_NOTA,
      inputSchema: { confirmacao: z.string().min(4).max(24) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => confirmarNota(ctx, quem, args, registrar),
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
  const eles = { id: usuario, ...(quem.email ? { email: quem.email } : {}), ...(quem.clientId ? { clientId: quem.clientId } : {}) };
  registrarEscritaAsaas(server, asaas, esc, eles, auditar);
  // nota fiscal: escrita em DOIS passos (preparar → confirmar), pelo mesmo portão e a mesma lista de quem escreve
  registrarNotasFiscaisAsaas(server, asaas, esc, eles, auditar);
  return true;
}
