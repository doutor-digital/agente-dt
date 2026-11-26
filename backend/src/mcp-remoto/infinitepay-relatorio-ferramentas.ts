/**
 * As ferramentas do conector para o que a API da InfinitePay não lê: importar o relatório que a clínica exporta do app e consultar o que foi importado.
 *
 *   infinitepay_pedir_relatorio       (só quem escreve)  devolve o LINK DE ENVIO do cofre (o mesmo fluxo de arquivo do conector) e diz, em passos, qual relatório a clínica baixa;
 *   infinitepay_importar_relatorio    (só quem escreve)  pega o arquivo que chegou, lê (OFX hoje; CSV só com leiaute cadastrado), grava e apaga o arquivo do cofre;
 *   infinitepay_extrato               (leitura)          lançamentos importados, entradas, saídas e líquido, com a COBERTURA;
 *   infinitepay_vendas                (leitura)          vendas importadas por forma de pagamento, bruto, líquido e taxa, com a COBERTURA;
 *   infinitepay_importacoes           (leitura)          o que já foi importado e os períodos cobertos.
 * Sem exemplo real de CSV da InfinitePay, vendas e recebíveis ainda não têm leiaute: ver `LEIAUTES_CSV`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, diasNoPeriodo, validarData } from '../franquia-mcp/travas.js';
import { CofreDeArquivos, ErroDeCofre } from './cofre-arquivos.js';
import { executar } from './ferramenta.js';
import { resolverContaInfinitepay, type ContextoInfinitepay } from './infinitepay.js';
import {
  RELATORIOS, coberturaDoPeriodo, importarRelatorio, totaisDasVendas, totaisDoExtrato,
  type ArmazemDeRelatorios, type TipoDeRelatorio, type VendaGuardada,
} from './infinitepay-relatorio.js';

export const DESTINO_RELATORIO = 'infinitepay-relatorio';
export const ENVIO_RELATORIO_VALE_MS = 30 * 60_000;
export const RELATORIO_MAX_BYTES = 10 * 1024 * 1024;
const MAX_LEITURA = 5000;
const MAX_DIAS = 366;
const FORMATOS: Record<TipoDeRelatorio, Array<'ofx' | 'csv'>> = { extrato: ['ofx', 'csv'], vendas: ['csv'], recebiveis: ['csv'] };

/**
 * Como a clínica baixa cada relatório. Os caminhos vêm da Central de Ajuda da InfinitePay (artigos "Como gerar um relatório de vendas pelo navegador",
 * "...pelo app", "Como gerar um extrato de movimentações" e "Como acompanho meus depósitos pelo navegador", lidos em 26/11/2026). O app muda: se o menu não
 * bater, a clínica fala com o chat do próprio app.
 */
export const COMO_EXPORTAR: Record<TipoDeRelatorio, { nome: string; passos: string[]; formato: string; observacao: string }> = {
  vendas: {
    nome: 'Relatório de vendas (maquininha, InfiniteTap, link de pagamento, Pix)',
    passos: [
      'Conta Web da InfinitePay (app.infinitepay.io, entrar com o login da clínica) > menu "Suas Vendas" > "Recebendo hoje".',
      'Escolher o PERÍODO (ex.: o mês inteiro) e deixar os outros filtros SEM restrição: status, tipo de venda, meio de pagamento e bandeira vazios, para vir tudo. Para ver as vendas no cartão é preciso marcar Crédito e Débito.',
      'Clicar em "Relatório" e baixar em CSV.',
      'Pelo app, o caminho equivalente é: Vendas > "Vendas hoje" > "Ver todas" > período e Filtros > tocar no total de vendas > "Baixar relatório" (CSV).',
    ],
    formato: 'CSV (o PDF não é lido; o OFX do relatório de vendas não traz forma de pagamento nem taxa)',
    observacao: 'Venda em Pix na Maquininha Smart aparece no relatório mas não entra no total de recebimentos (o dinheiro cai na hora).',
  },
  extrato: {
    nome: 'Extrato de movimentações da conta (entradas e saídas de dinheiro)',
    passos: [
      'App InfinitePay (atualizado) > tocar no SALDO disponível > "Filtros" (deixar tudo, para vir completo).',
      'Tocar no ícone de seta para baixo (download) > "Alterar" para escolher o período.',
      'Escolher o formato OFX (de preferência) ou CSV. O relatório é enviado para o e-mail cadastrado da clínica e pode levar alguns minutos (olhar o spam).',
      'Baixar o arquivo do e-mail e enviar pelo link de envio.',
    ],
    formato: 'OFX (ou CSV)',
    observacao: 'Peça um mês por vez, o mesmo mês de cada vez: o conector não soma arquivos repetidos e mostra quais períodos já foram importados.',
  },
  recebiveis: {
    nome: 'Relatório de recebimentos (o que a InfinitePay depositou, com bruto, taxa e líquido)',
    passos: [
      'Conta Web da InfinitePay > menu "Seus recebimentos".',
      '"Definir novo período" para escolher as datas e "Filtros" se precisar (deixar tudo, para vir completo).',
      'Clicar em "Relatório" e baixar em CSV.',
    ],
    formato: 'CSV',
    observacao: 'Ao clicar num pagamento a tela mostra o valor líquido, o bruto e o desconto de taxas: o CSV deve trazer essas três colunas.',
  },
};

export interface DepsRelatorio {
  /** o segredo do servidor que faz do hash da conta um HMAC (em produção: INFINITEPAY_CONTA_SEGREDO ou derivado de SESSION_JWT_SECRET) */
  segredoDaConta: string;
  cofre: CofreDeArquivos;
  baseUrl: () => string;
  armazem: ArmazemDeRelatorios;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** O dia em Brasília (UTC-3) de um instante ISO: venda das 22h30 de 30/11 grava 01/12 em UTC e é do dia 30. */
export const diaDeBrasilia = (isoUtc: string): string => new Date(Date.parse(isoUtc) - 3 * 3_600_000).toISOString().slice(0, 10);

function periodo(inicio: string, fim: string) {
  const i = validarData(inicio, 'inicio');
  const f = validarData(fim, 'fim');
  if (i > f) throw new ErroDeEntrada('o início vem depois do fim');
  if (diasNoPeriodo(i, f) > MAX_DIAS) throw new ErroDeEntrada(`o período passa de ${MAX_DIAS} dias: divida em partes`);
  return { inicio: i, fim: f };
}

const unidadeArg = z.string().optional().describe('unidade com InfinitePay (slug ou nome curto); opcional se só houver uma. Veja listar_integracoes.');

// ----------------------------------------------------------------- leitura

export async function infinitepayExtrato(
  ctx: ContextoInfinitepay,
  armazem: ArmazemDeRelatorios,
  a: { unidade?: string; inicio: string; fim: string; tipo?: 'extrato' | 'recebivel'; maxItens?: number },
  opc: { descricoes?: boolean } = {},
) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  const p = periodo(a.inicio, a.fim);
  // extrato e recebível NUNCA se misturam num total: o recebível é o dinheiro que depois cai no extrato (somar os dois conta duas vezes)
  const tipo = a.tipo ?? 'extrato';
  const lidos = await armazem.movimentos({ unidade: conta.slug, tipo, de: p.inicio, ate: p.fim, limite: MAX_LEITURA + 1 });
  const cortou = lidos.length > MAX_LEITURA;
  const linhas = cortou ? lidos.slice(0, MAX_LEITURA) : lidos;
  const max = Math.min(Math.max(a.maxItens ?? 50, 0), 500);
  const importacoes = await armazem.importacoes(conta.slug, tipo === 'recebivel' ? 'recebiveis' : 'extrato');
  const porDia: Record<string, { entradas: number; saidas: number }> = {};
  for (const l of linhas) {
    const g = (porDia[l.data] ??= { entradas: 0, saidas: 0 });
    if (l.valorCentavos > 0) g.entradas = Math.round((g.entradas + l.valorCentavos / 100) * 100) / 100;
    else g.saidas = Math.round((g.saidas + l.valorCentavos / 100) * 100) / 100;
  }
  return {
    unidade: conta.slug,
    fonte: 'RELATÓRIO IMPORTADO (a API da InfinitePay não lê extrato), não o saldo ao vivo',
    periodo: { ...p, dias: diasNoPeriodo(p.inicio, p.fim) },
    resumo: totaisDoExtrato(linhas),
    porDia: Object.fromEntries(Object.entries(porDia).sort(([x], [y]) => (x < y ? -1 : 1))),
    tipo,
    itens: linhas.slice(0, max).map((l) => ({ data: l.data, ...(l.dataPrevista ? { dataPrevista: l.dataPrevista } : {}), tipo: l.tipo, valor: l.valorCentavos / 100, ...(opc.descricoes ? { descricao: l.descricao } : {}) })),
    ...(opc.descricoes ? {} : { descricoes: 'omitidas: a descrição do lançamento pode ter o nome de quem pagou e só quem tem permissão de escrita no conector a vê' }),
    itensOmitidos: Math.max(linhas.length - max, 0),
    cobertura: coberturaDoPeriodo(importacoes, p.inicio, p.fim),
    ...(cortou ? { truncado: true, aviso: `mais de ${MAX_LEITURA} lançamentos: divida o período. Os totais estão INCOMPLETOS.` } : {}),
  };
}

type Agrupar = 'forma' | 'dia' | 'bandeira' | 'status';

export async function infinitepayVendas(ctx: ContextoInfinitepay, armazem: ArmazemDeRelatorios, a: { unidade?: string; inicio: string; fim: string; agruparPor?: Agrupar }) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  const p = periodo(a.inicio, a.fim);
  const lidas = await armazem.vendas({ unidade: conta.slug, de: p.inicio, ate: p.fim, limite: MAX_LEITURA + 1 });
  const cortou = lidas.length > MAX_LEITURA;
  const vendas = cortou ? lidas.slice(0, MAX_LEITURA) : lidas;
  const importacoes = await armazem.importacoes(conta.slug, 'vendas');
  const chave: Record<Agrupar, (v: VendaGuardada) => string> = {
    forma: (v) => (v.forma === 'credito' && (v.parcelas ?? 1) > 1 ? 'credito parcelado' : v.forma),
    dia: (v) => diaDeBrasilia(v.quando),
    bandeira: (v) => v.bandeira ?? '(sem bandeira)',
    status: (v) => v.status ?? '(sem status)',
  };
  const por = a.agruparPor ?? 'forma';
  const grupos: Record<string, VendaGuardada[]> = {};
  for (const v of vendas) (grupos[chave[por](v)] ??= []).push(v);
  return {
    unidade: conta.slug,
    fonte: 'RELATÓRIO IMPORTADO (a API da InfinitePay não lê vendas)',
    periodo: { ...p, dias: diasNoPeriodo(p.inicio, p.fim) },
    resumo: totaisDasVendas(vendas),
    agrupadoPor: por,
    grupos: Object.fromEntries(Object.entries(grupos).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, totaisDasVendas(v)])),
    cobertura: coberturaDoPeriodo(importacoes, p.inicio, p.fim),
    ...(vendas.length === 0 && importacoes.length === 0
      ? { proximoPasso: 'Nenhum relatório de vendas foi importado. Use infinitepay_pedir_relatorio (relatorio="vendas"); o leiaute do CSV da InfinitePay ainda precisa ser cadastrado com o primeiro arquivo real.' }
      : {}),
    ...(cortou ? { truncado: true, aviso: `mais de ${MAX_LEITURA} vendas: divida o período. Os totais estão INCOMPLETOS.` } : {}),
  };
}

export async function infinitepayImportacoes(ctx: ContextoInfinitepay, armazem: ArmazemDeRelatorios, a: { unidade?: string; relatorio?: TipoDeRelatorio }) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  const lista = await armazem.importacoes(conta.slug, a.relatorio);
  return {
    unidade: conta.slug,
    // a conta do arquivo (hash e final) NÃO sai para quem só lê: o final de uma conta bancária é dado financeiro; quem importa o vê na resposta da importação
    importacoes: lista.map(({ contaHash: _hash, contaFinal: _final, ...resto }) => ({ ...resto })),
    cobertura: coberturaDoPeriodo(lista),
    leiautesDeCsv: 'nenhum cadastrado ainda: só o OFX do extrato é lido hoje',
  };
}

// ----------------------------------------------------------------- importação (quem escreve)

export async function pedirRelatorio(ctx: ContextoInfinitepay, deps: DepsRelatorio, quem: { id: string; email?: string }, a: { unidade?: string; relatorio: TipoDeRelatorio }) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  const como = COMO_EXPORTAR[a.relatorio];
  const formatos = FORMATOS[a.relatorio];
  let p;
  try {
    p = deps.cofre.pedirEnvio({
      userId: quem.id,
      finalidade: `relatório da InfinitePay (${a.relatorio}) de ${conta.nome}, em ${formatos.map((f) => f.toUpperCase()).join(' ou ')}`,
      validoMs: ENVIO_RELATORIO_VALE_MS,
      tipos: formatos,
      tamanhoMaxBytes: RELATORIO_MAX_BYTES,
      destino: { tipo: DESTINO_RELATORIO, unidade: conta.slug, relatorio: a.relatorio },
    });
  } catch (e) {
    if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
    throw e;
  }
  return {
    unidade: conta.slug,
    envio: p.id,
    linkDeEnvio: `${deps.baseUrl().replace(/\/+$/, '')}/arquivos/enviar/${p.token}`,
    validoAte: iso(p.validoAte),
    aceita: formatos,
    tamanhoMaxMB: RELATORIO_MAX_BYTES / 1024 / 1024,
    relatorioPedido: como.nome,
    comoBaixar: como.passos,
    formatoQuePedir: como.formato,
    observacao: como.observacao,
    aviso: 'Quem baixa é a clínica (login dela). O link é de uso único e vale 30 minutos; não cole em lugar público. O arquivo tem o movimento financeiro da clínica: só o conector o lê.',
    proximoPasso: `Quando o arquivo tiver sido enviado (a página diz "Pronto!"), chame infinitepay_importar_relatorio com envio="${p.id}".`,
  };
}

export async function importarEnvio(ctx: ContextoInfinitepay, deps: DepsRelatorio, quem: { id: string; email?: string }, a: { envio: string; aceitarOutraConta?: boolean }) {
  let guardado;
  let d;
  try {
    guardado = deps.cofre.destinoDe(quem.id, a.envio);
    if (!guardado || guardado.tipo !== DESTINO_RELATORIO) throw new ErroDeEntrada('esse envio não foi pedido por infinitepay_pedir_relatorio: não sei de que unidade é o arquivo. Peça um novo link.');
    // a unidade é conferida ANTES de abrir: abrir marca o envio como em uso, e uma unidade que saiu do ar não pode deixá-lo preso até vencer
    resolverContaInfinitepay(ctx, guardado.unidade);
    // `abrir` marca o envio como em uso antes de qualquer espera: uma segunda chamada ao mesmo tempo é recusada (nada de importação em dobro)
    d = await deps.cofre.abrir(quem.id, a.envio);
  } catch (e) {
    if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
    throw e;
  }
  const relatorio = guardado.relatorio as TipoDeRelatorio;
  const conta = resolverContaInfinitepay(ctx, guardado.unidade);
  if (!RELATORIOS.includes(relatorio) || (d.tipo !== 'ofx' && d.tipo !== 'csv')) {
    deps.cofre.soltar(quem.id, a.envio);
    throw new ErroDeEntrada('o pedido deste envio está incompleto ou o arquivo não é OFX/CSV: peça um novo link por infinitepay_pedir_relatorio.');
  }
  let r;
  try {
    r = await importarRelatorio(deps.armazem, { unidade: conta.slug, relatorio, tipoDoCofre: d.tipo, conteudo: d.conteudo, importadoPor: quem.email || `usuario:${quem.id}`, segredoDaConta: deps.segredoDaConta, ...(a.aceitarOutraConta ? { aceitarOutraConta: true } : {}) });
  } catch (e) {
    // falha de banco ou arquivo ilegível: o arquivo continua no cofre (até vencer) para tentar de novo depois de corrigir
    deps.cofre.soltar(quem.id, a.envio);
    throw e;
  }
  // outra conta: o arquivo FICA no cofre (até vencer) para a pessoa confirmar com aceitarOutraConta=true sem pedir de novo à clínica
  if (!r.importado && r.motivo === 'outra_conta') {
    deps.cofre.soltar(quem.id, a.envio);
    return { unidade: conta.slug, ...r, arquivoApagadoDoCofre: false };
  }
  // o conector já decidiu (importou, repetido, de outra unidade ou leiaute desconhecido): o arquivo não tem mais o que fazer no cofre
  deps.cofre.apagar(quem.id, a.envio);
  return { unidade: conta.slug, ...r, arquivoApagadoDoCofre: true };
}

// ----------------------------------------------------------------- registro

/** `descricoes`: quem pode ver a descrição dos lançamentos (pode ter o nome de quem pagou): só quem escreve no conector. Os números todos saem para qualquer um. */
export function registrarLeituraRelatorios(server: McpServer, ctx: ContextoInfinitepay, armazem: ArmazemDeRelatorios, auditar?: Auditar, opc: { descricoes?: boolean } = {}): void {
  const ro = { readOnlyHint: true, openWorldHint: false };
  server.registerTool(
    'infinitepay_extrato',
    {
      title: 'Extrato da InfinitePay (relatório importado)',
      description:
        'Lançamentos do EXTRATO (ou dos recebíveis) da InfinitePay de uma unidade num período, com entradas, saídas, líquido e por dia. Vem de relatório que a clínica ' +
        'exportou do app e foi importado (a API da InfinitePay não lê extrato): NÃO é o saldo ao vivo, e todo total traz a COBERTURA: só vale para os períodos importados, ' +
        'com as lacunas listadas. Sem importação, os números são zero por falta de dado. A descrição do lançamento (pode ter o nome de quem pagou) só aparece para quem tem permissão de escrita.',
      inputSchema: {
        unidade: unidadeArg,
        inicio: z.string().describe('primeiro dia, AAAA-MM-DD'),
        fim: z.string().describe('último dia (incluso), AAAA-MM-DD; até 366 dias'),
        tipo: z.enum(['extrato', 'recebivel']).optional().describe('padrão: extrato. Extrato e recebível nunca são somados juntos (o recebível é o dinheiro que depois cai no extrato)'),
        maxItens: z.number().int().min(0).max(500).optional().describe('quantos lançamentos listar (padrão 50; 0 = só os números)'),
      },
      annotations: ro,
    },
    (args) => executar('infinitepay_extrato', args, auditar, () => infinitepayExtrato(ctx, armazem, args, opc)),
  );
  server.registerTool(
    'infinitepay_vendas',
    {
      title: 'Vendas da InfinitePay (relatório importado)',
      description:
        'Vendas da InfinitePay (maquininha, Pix, link) de uma unidade num período: quantidade, bruto, líquido, taxa e taxa efetiva, por forma de pagamento (ou dia, bandeira, ' +
        'status). Vem de relatório CSV que a clínica exportou e foi importado (a API da InfinitePay não lê vendas). Todo total traz a COBERTURA (períodos importados e ' +
        'lacunas): o que não foi importado não está somado. Sem importação o resultado é zero por falta de dado.',
      inputSchema: {
        unidade: unidadeArg,
        inicio: z.string().describe('primeiro dia, AAAA-MM-DD'),
        fim: z.string().describe('último dia (incluso), AAAA-MM-DD; até 366 dias'),
        agruparPor: z.enum(['forma', 'dia', 'bandeira', 'status']).optional().describe('padrão: forma de pagamento'),
      },
      annotations: ro,
    },
    (args) => executar('infinitepay_vendas', args, auditar, () => infinitepayVendas(ctx, armazem, args)),
  );
  server.registerTool(
    'infinitepay_importacoes',
    {
      title: 'Relatórios da InfinitePay já importados',
      description: 'Os arquivos já importados de uma unidade (relatório, formato, período, linhas novas, quem importou e quando) e os períodos cobertos. Use para saber o que falta pedir à clínica.',
      inputSchema: { unidade: unidadeArg, relatorio: z.enum(['extrato', 'vendas', 'recebiveis']).optional() },
      annotations: ro,
    },
    (args) => executar('infinitepay_importacoes', args, auditar, () => infinitepayImportacoes(ctx, armazem, args)),
  );
}

export function registrarImportacaoRelatorios(server: McpServer, ctx: ContextoInfinitepay, deps: DepsRelatorio, quem: { id: string; email?: string }, auditar: Auditar): void {
  server.registerTool(
    'infinitepay_pedir_relatorio',
    {
      title: 'Pedir à clínica o relatório da InfinitePay (link de envio)',
      description:
        'PASSO 1 de 2 para trazer ao conector o que a API da InfinitePay não lê (vendas, extrato, recebíveis). Devolve o LINK DE ENVIO (uso único, 30 minutos, só OFX/CSV ' +
        'até 10 MB) e os PASSOS exatos de como a clínica baixa o relatório no app ou na Conta Web. Entregue o link e os passos à pessoa da clínica. Não grava nada. ' +
        'relatorio: "extrato" (OFX), "vendas" (CSV) ou "recebiveis" (CSV).',
      inputSchema: { unidade: unidadeArg, relatorio: z.enum(['extrato', 'vendas', 'recebiveis']) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => executar('infinitepay_pedir_relatorio', args, auditar, () => pedirRelatorio(ctx, deps, quem, args)),
  );
  server.registerTool(
    'infinitepay_importar_relatorio',
    {
      title: 'Importar o relatório da InfinitePay que a clínica enviou',
      description:
        'PASSO 2 de 2. Lê o arquivo que chegou pelo link de infinitepay_pedir_relatorio e grava as linhas (o mesmo arquivo duas vezes não entra de novo; linhas repetidas de ' +
        'arquivos que se sobrepõem também não). OFX de extrato é lido; CSV só se o leiaute já estiver cadastrado: CSV desconhecido NÃO grava nada e devolve só o ' +
        'cabeçalho para o João cadastrar o leiaute. Recusa (sem gravar) o mesmo arquivo já importado em OUTRA unidade e o extrato de OUTRA conta que a já importada da unidade. Depois apaga o arquivo do cofre. Mostra períodos, linhas novas e totais do arquivo; confira com o app antes de confiar nos números.',
      inputSchema: {
        envio: z.string().trim().min(8).max(64).describe('o "envio" devolvido por infinitepay_pedir_relatorio'),
        aceitarOutraConta: z.boolean().optional().describe('só depois de a importação recusar por ser de OUTRA conta que a já importada: true confirma que a unidade tem mesmo duas contas'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => executar('infinitepay_importar_relatorio', args, auditar, () => importarEnvio(ctx, deps, quem, args)),
  );
}

/** Só quem escreve (a mesma lista do conector) ganha pedir e importar. A leitura vai para todos, como as outras fontes financeiras. */
export function registrarImportacaoRelatoriosSePermitido(
  server: McpServer, ctx: ContextoInfinitepay, deps: DepsRelatorio, usuario: string, escritores: ReadonlySet<string>, auditar: Auditar, quem: { email?: string } = {},
): boolean {
  if (!escritores.has(usuario)) return false;
  registrarImportacaoRelatorios(server, ctx, deps, { id: usuario, ...(quem.email ? { email: quem.email } : {}) }, auditar);
  return true;
}
