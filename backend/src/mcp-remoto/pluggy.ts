/**
 * Pluggy (Open Finance) no conector — LEITURA BANCÁRIA, só leitura. Conta pessoal "Meu Pluggy": até 5 conexões do mesmo titular, dados atualizados 1 vez
 * por dia pelo próprio Meu Pluggy. As credenciais e os ids dos itens vêm do ambiente do servidor (ver `lib/integracoes/pluggy.ts`).
 *
 * Dado bancário é SENSÍVEL: estas ferramentas só existem para quem pode alterar cartões (MCP_ESCRITA_EMAILS, o grupo mais restrito do conector, o mesmo
 * que lê asaas_notas). Quem não está na lista nem as vê, e o listar_integracoes não menciona a Pluggy para ele. Sem as variáveis, ninguém vê.
 *
 *   - `pluggy_contas`:   contas de uma empresa (banco, tipo, número mascarado, saldo) e a data da última sincronização; `testar=true` prova as credenciais;
 *   - `pluggy_extrato`:  lançamentos de um período (até 90 dias) com totais de entrada e saída e filtros por valor mínimo e por texto;
 *   - `pluggy_resumo`:   entrou e saiu por dia ou por semana.
 * Toda resposta diz de quando são os dados (a última sincronização de cada item): o extrato NUNCA é "de agora".
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, diasNoPeriodo, somarDias, validarData, validarTexto } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { acharSlug } from './unidades.js';
import {
  ErroPluggy,
  itemMascarado,
  numeroMascarado,
  tirarSegredos,
  type ContaPluggy,
  type FontePluggy,
  type ItemConfigurado,
  type ItemPluggy,
  type LancamentoPluggy,
} from '../lib/integracoes/pluggy.js';

export interface ContextoPluggy {
  /** os itens configurados que viraram empresa de verdade (substituído a cada renovação da lista) */
  itens: ItemConfigurado[];
  /** o cliente HTTP único do processo; null sem credenciais */
  fonte: FontePluggy | null;
  agora: () => number;
}

export function criarContextoPluggy(itens: ItemConfigurado[], fonte: FontePluggy | null, op: { agora?: () => number } = {}): ContextoPluggy {
  return { itens, fonte, agora: op.agora ?? Date.now };
}

/** empresa -> nome, para o listar_integracoes */
export function empresasDoPluggy(ctx: ContextoPluggy): Map<string, { nome: string }> {
  return new Map(ctx.itens.map((i) => [i.empresa, { nome: i.nomeDaEmpresa }]));
}

export const MAX_DIAS = 90;
const MAX_LANCAMENTOS = 200;
const IDADE_MAXIMA_H = 36;

export const AVISO_DE_FRESCOR = 'Os dados são os da última sincronização diária do Meu Pluggy (campo ultimaSincronizacao de cada item): lançamentos de hoje e de ontem podem ainda não estar aqui.';

function fonteDe(ctx: ContextoPluggy): FontePluggy {
  if (!ctx.fonte || !ctx.itens.length) throw new ErroDeEntrada('a leitura bancária (Pluggy) não está ligada neste servidor (PLUGGY_CLIENT_ID, PLUGGY_CLIENT_SECRET e PLUGGY_ITENS no ambiente).');
  return ctx.fonte;
}

export function resolverEmpresa(ctx: ContextoPluggy, alvo: string | undefined): string {
  const empresas = [...new Set(ctx.itens.map((i) => i.empresa))];
  if (!empresas.length) fonteDe(ctx);
  if (!alvo || !alvo.trim()) {
    if (empresas.length === 1) return empresas[0]!;
    throw new ErroDeEntrada(`diga a empresa. Com leitura bancária: ${empresas.join(', ')}`);
  }
  const slug = acharSlug(empresas, alvo);
  if (!slug) throw new ErroDeEntrada(`empresa sem leitura bancária, desconhecida ou ambígua: ${alvo}. Com leitura bancária: ${empresas.join(', ')}`);
  return slug;
}

const apelidoOuFinal = (i: ItemConfigurado) => i.apelido ?? itemMascarado(i.itemId);

// ----------------------------------------------------------------- frescor

export function frescorDoItem(i: ItemConfigurado, it: ItemPluggy | null, agoraMs: number) {
  const avisos: string[] = [];
  let idadeHoras: number | null = null;
  if (!it) avisos.push('não consegui ler o status desta conexão na Pluggy: a data da última sincronização é desconhecida');
  if (it) {
    const quando = it.atualizadoEm ? Date.parse(it.atualizadoEm) : NaN;
    if (Number.isNaN(quando)) avisos.push('a Pluggy não informou a data da última sincronização deste item');
    else {
      idadeHoras = Math.max(0, Math.round(((agoraMs - quando) / 3_600_000) * 10) / 10);
      if (idadeHoras > IDADE_MAXIMA_H) avisos.push(`dados com ${Math.round(idadeHoras)} h: o Meu Pluggy sincroniza 1 vez por dia, então estes dados estão atrasados mais que o normal`);
    }
    if (it.status && it.status !== 'UPDATED' && it.status !== 'UPDATING') avisos.push(`a conexão está em ${it.status}${it.erroCodigo ? ` (${it.erroCodigo})` : ''}: o banco pode não estar sincronizando`);
    const vence = it.consentimentoExpiraEm ? Date.parse(it.consentimentoExpiraEm) : NaN;
    if (!Number.isNaN(vence)) {
      if (vence < agoraMs) avisos.push('o consentimento do Meu Pluggy VENCEU: as leituras voltam vazias. Reautorize em Applications → Demo → Connect Account → MeuPluggy no Dashboard da Pluggy');
      else if (vence - agoraMs < 30 * 86_400_000) avisos.push(`o consentimento do Meu Pluggy vence em ${Math.ceil((vence - agoraMs) / 86_400_000)} dia(s): reautorize antes`);
    }
  }
  return {
    empresa: i.empresa,
    item: apelidoOuFinal(i),
    banco: it?.banco ?? null,
    ultimaSincronizacao: it?.atualizadoEm ?? null,
    idadeHoras,
    statusDoItem: it?.status ?? null,
    consentimentoExpiraEm: it?.consentimentoExpiraEm ?? null,
    ...(avisos.length ? { avisos } : {}),
  };
}

const rotuloDaConta = (banco: string | null, c: ContaPluggy) => [banco ?? 'banco', c.nome, numeroMascarado(c.numero)].filter(Boolean).join(' ');
const ehCartao = (c: { tipo: string | null }) => c.tipo === 'CREDIT';
const reais = (centavos: number) => Math.round(centavos) / 100;
const centavos = (v: number) => Math.round(Math.abs(v) * 100);

// ----------------------------------------------------------------- pluggy_contas

export async function pluggyContas(ctx: ContextoPluggy, a: { empresa?: string; testar?: boolean }) {
  const fonte = fonteDe(ctx);
  const empresa = a.empresa?.trim() ? resolverEmpresa(ctx, a.empresa) : undefined;
  const itens = ctx.itens.filter((i) => !empresa || i.empresa === empresa);
  let credenciais: { ok: boolean; erro?: string } | undefined;
  if (a.testar) {
    try {
      await fonte.testar();
      credenciais = { ok: true };
    } catch (e) {
      credenciais = { ok: false, erro: e instanceof Error ? e.message : String(e) };
    }
  }
  const agora = ctx.agora();
  const lidos = credenciais && !credenciais.ok
    ? []
    : await Promise.all(
        itens.map(async (i) => {
          try {
            const [it, contas] = await Promise.all([fonte.item(i.itemId), fonte.contas(i.itemId)]);
            return {
              ...frescorDoItem(i, it, agora),
              contas: contas.map((c) => ({
                id: c.id,
                rotulo: rotuloDaConta(it.banco, c),
                tipo: c.tipo,
                subtipo: c.subtipo,
                nome: c.nome,
                numero: numeroMascarado(c.numero),
                saldo: c.saldo,
                moeda: c.moeda,
                ...(c.limiteDisponivel !== undefined ? { limiteDisponivel: c.limiteDisponivel } : {}),
                ...(c.limiteTotal !== undefined ? { limiteTotal: c.limiteTotal } : {}),
              })),
            };
          } catch (e) {
            return { ...frescorDoItem(i, null, agora), erro: e instanceof Error ? e.message : String(e), contas: [] };
          }
        }),
      );
  return {
    ...(credenciais ? { credenciais } : {}),
    total: lidos.length,
    itens: lidos,
    aviso: AVISO_DE_FRESCOR,
    nota: 'saldo em reais, como o banco informou na última sincronização; em cartão de crédito é a fatura, não o dinheiro em conta.',
  };
}

// ----------------------------------------------------------------- leitura comum (extrato e resumo)

export interface LancamentoDaConta extends LancamentoPluggy {
  contaId: string;
  conta: string;
  contaTipo: string | null;
}

export interface Leitura {
  empresa: string;
  inicio: string;
  fim: string;
  frescor: Array<ReturnType<typeof frescorDoItem>>;
  lancamentos: LancamentoDaConta[];
  contasLidas: number;
  /** alguma parte não veio (conta ou item que falhou, ou corte por páginas): os totais ficam INCOMPLETOS */
  incompleto: boolean;
  falhas: string[];
}

function validarPeriodo(inicio: string, fim: string): void {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (inicio > fim) throw new ErroDeEntrada('o início vem depois do fim');
  if (diasNoPeriodo(inicio, fim) > MAX_DIAS) throw new ErroDeEntrada(`período de até ${MAX_DIAS} dias; peça em partes (recebi ${diasNoPeriodo(inicio, fim)} dias)`);
}

export async function lerPeriodo(ctx: ContextoPluggy, a: { empresa?: string; conta?: string; inicio: string; fim: string }): Promise<Leitura> {
  const fonte = fonteDe(ctx);
  validarPeriodo(a.inicio, a.fim);
  const empresa = resolverEmpresa(ctx, a.empresa);
  const itens = ctx.itens.filter((i) => i.empresa === empresa);
  const agora = ctx.agora();
  // cada falha guarda de QUAL item veio: com uma conta pedida, a queda de outro item não é problema dela
  const falhas: Array<{ item: string; texto: string }> = [];
  const doItem = await Promise.all(
    itens.map(async (i) => {
      const [it, contas] = await Promise.allSettled([fonte.item(i.itemId), fonte.contas(i.itemId)]);
      if (contas.status === 'rejected') falhas.push({ item: i.itemId, texto: `${apelidoOuFinal(i)}: ${msg(contas.reason)}` });
      return { i, it: it.status === 'fulfilled' ? it.value : null, contas: contas.status === 'fulfilled' ? contas.value : [] };
    }),
  );
  const todas = doItem.flatMap((d) => d.contas.map((c) => ({ ...d, c })));
  let alvo = todas;
  if (a.conta?.trim()) {
    // só vale conta de um item DESTA empresa: o id sozinho não dá acesso a conta de outra empresa
    alvo = todas.filter((x) => x.c.id === a.conta!.trim());
    // se as contas de algum item não vieram, a conta pedida pode estar nele: o erro é a falha, não "conta de outra empresa"
    if (!alvo.length && falhas.length) throw new ErroPluggy(falhas.map((f) => f.texto).join('; '));
    if (!alvo.length) throw new ErroDeEntrada(`essa conta não é de nenhum item da empresa ${empresa}. Veja os ids em pluggy_contas.`);
  }
  const lidas = await Promise.all(
    alvo.map(async (x) => {
      const rotulo = rotuloDaConta(x.it?.banco ?? null, x.c);
      try {
        const r = await fonte.transacoes(x.c.id, a.inicio, a.fim);
        if (r.truncado) falhas.push({ item: x.i.itemId, texto: `${rotulo}: lançamentos demais, a leitura parou antes do fim do período` });
        return r.lancamentos.map((l): LancamentoDaConta => ({ ...l, contaId: x.c.id, conta: rotulo, contaTipo: x.c.tipo }));
      } catch (e) {
        falhas.push({ item: x.i.itemId, texto: `${rotulo}: ${msg(e)}` });
        return [];
      }
    }),
  );
  const envolvidos = new Set(alvo.map((x) => x.i.itemId));
  // com uma conta pedida só contam as falhas do item DELA, e aí a falha é o erro (não há "resto" para mostrar)
  const relevantes = a.conta?.trim() ? falhas.filter((f) => envolvidos.has(f.item)) : falhas;
  if (a.conta?.trim() && relevantes.length) throw new ErroPluggy(relevantes.map((f) => f.texto).join('; '));
  return {
    empresa,
    inicio: a.inicio,
    fim: a.fim,
    frescor: doItem.filter((d) => !a.conta?.trim() || envolvidos.has(d.i.itemId)).map((d) => frescorDoItem(d.i, d.it, agora)),
    lancamentos: lidas.flat(),
    contasLidas: alvo.length,
    incompleto: relevantes.length > 0,
    falhas: relevantes.map((f) => f.texto),
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** entrou/saiu em reais. Conta corrente e cartão de crédito NUNCA se somam: pagar a fatura sai da conta E já está nas compras do cartão. */
function totais(ls: ReadonlyArray<LancamentoDaConta>) {
  const soma = (filtro: (l: LancamentoDaConta) => boolean) => {
    let entrou = 0;
    let saiu = 0;
    let n = 0;
    for (const l of ls) {
      if (!filtro(l) || l.status === 'PENDING') continue;
      n += 1;
      if (l.tipo === 'entrada') entrou += centavos(l.valor);
      else saiu += centavos(l.valor);
    }
    return { entrou: reais(entrou), saiu: reais(saiu), saldoDoPeriodo: reais(entrou - saiu), lancamentos: n };
  };
  const bancarias = soma((l) => !ehCartao({ tipo: l.contaTipo }));
  const cartoes = soma((l) => ehCartao({ tipo: l.contaTipo }));
  return { contasBancarias: bancarias, ...(cartoes.lancamentos ? { cartoesDeCredito: cartoes } : {}) };
}

const NOTA_DOS_TOTAIS =
  'entrou/saiu somam o valor de cada lançamento JÁ EFETIVADO: os pendentes (status PENDING, que o banco ainda pode trocar ou cancelar) aparecem na lista e em `pendentes`, mas NÃO entram nos totais. Transferência entre as próprias contas aparece como saída numa e entrada na outra. Cartão de crédito vem separado: compra no cartão e o pagamento da fatura na conta são o mesmo dinheiro, nunca some os dois blocos.';

// ----------------------------------------------------------------- pluggy_extrato

export async function pluggyExtrato(
  ctx: ContextoPluggy,
  a: { empresa?: string; conta?: string; inicio: string; fim: string; valorMinimo?: number; texto?: string; tipo?: 'entrada' | 'saida'; maxItens?: number },
) {
  const texto = validarTexto(a.texto, 'texto');
  if (a.valorMinimo !== undefined && (!Number.isFinite(a.valorMinimo) || a.valorMinimo < 0)) throw new ErroDeEntrada('valorMinimo: use um valor em reais, zero ou maior');
  const max = Math.min(Math.max(a.maxItens ?? 50, 0), MAX_LANCAMENTOS);
  const leitura = await lerPeriodo(ctx, a);
  const minimo = a.valorMinimo === undefined ? undefined : Math.round(a.valorMinimo * 100);
  const busca = texto ? semAcento(texto) : undefined;
  const passam = leitura.lancamentos.filter((l) => {
    if (a.tipo && l.tipo !== a.tipo) return false;
    if (minimo !== undefined && centavos(l.valor) < minimo) return false;
    if (busca && ![l.descricao, l.pagador, l.recebedor, l.motivo].some((c) => c && semAcento(c).includes(busca))) return false;
    return true;
  });
  // mais recente primeiro; a ordem da Pluggy é mantida entre lançamentos do mesmo dia
  const ordenados = [...passam].sort((x, y) => (x.data < y.data ? 1 : x.data > y.data ? -1 : 0));
  return {
    empresa: leitura.empresa,
    periodo: { inicio: leitura.inicio, fim: leitura.fim },
    dadosDe: leitura.frescor,
    aviso: AVISO_DE_FRESCOR,
    contasLidas: leitura.contasLidas,
    lidos: leitura.lancamentos.length,
    filtros: { ...(a.tipo ? { tipo: a.tipo } : {}), ...(minimo !== undefined ? { valorMinimo: reais(minimo) } : {}), ...(texto ? { texto } : {}) },
    totaisValemPara: a.tipo || minimo !== undefined || texto ? 'só os lançamentos que passaram nos filtros' : 'todos os lançamentos do período',
    totais: totais(passam),
    notaDosTotais: NOTA_DOS_TOTAIS,
    pendentes: passam.filter((l) => l.status === 'PENDING').length,
    itens: ordenados.slice(0, max).map((l) => ({
      data: l.data,
      descricao: l.descricao,
      valor: l.valor,
      tipo: l.tipo,
      categoria: l.categoria,
      ...(l.status && l.status !== 'POSTED' ? { status: l.status } : {}),
      ...(l.pagador ? { pagador: l.pagador } : {}),
      ...(l.recebedor ? { recebedor: l.recebedor } : {}),
      ...(l.motivo ? { motivo: l.motivo } : {}),
      conta: l.conta,
    })),
    itensOmitidos: Math.max(ordenados.length - max, 0),
    ...(leitura.incompleto ? { incompleto: true, falhas: leitura.falhas, atencao: 'parte dos dados NÃO veio: os totais estão INCOMPLETOS.' } : {}),
  };
}

// ----------------------------------------------------------------- pluggy_resumo

/** segunda-feira da semana de um AAAA-MM-DD */
export function segundaDaSemana(dia: string): string {
  const dow = (new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7;
  return somarDias(dia, -dow);
}

export async function pluggyResumo(ctx: ContextoPluggy, a: { empresa?: string; conta?: string; inicio: string; fim: string; agrupar?: 'dia' | 'semana' }) {
  const agrupar = a.agrupar ?? 'dia';
  const leitura = await lerPeriodo(ctx, a);
  const baldes = new Map<string, { entrou: number; saiu: number; n: number }>();
  // cartão fica fora dos baldes (veja NOTA_DOS_TOTAIS); os totais dele vêm no bloco próprio
  for (const l of leitura.lancamentos) {
    if (ehCartao({ tipo: l.contaTipo }) || l.status === 'PENDING') continue;
    const chave = agrupar === 'semana' ? segundaDaSemana(l.data) : l.data;
    const b = baldes.get(chave) ?? { entrou: 0, saiu: 0, n: 0 };
    if (l.tipo === 'entrada') b.entrou += centavos(l.valor);
    else b.saiu += centavos(l.valor);
    b.n += 1;
    baldes.set(chave, b);
  }
  const periodos = [...baldes.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([inicio, b]) => ({
      ...(agrupar === 'semana' ? { semanaDe: inicio, ate: somarDias(inicio, 6) } : { dia: inicio }),
      entrou: reais(b.entrou),
      saiu: reais(b.saiu),
      saldo: reais(b.entrou - b.saiu),
      lancamentos: b.n,
    }));
  return {
    empresa: leitura.empresa,
    periodo: { inicio: leitura.inicio, fim: leitura.fim },
    agrupadoPor: agrupar,
    dadosDe: leitura.frescor,
    aviso: AVISO_DE_FRESCOR,
    contasLidas: leitura.contasLidas,
    pendentes: leitura.lancamentos.filter((l) => l.status === 'PENDING').length,
    totais: totais(leitura.lancamentos),
    notaDosTotais: NOTA_DOS_TOTAIS,
    periodos,
    observacao: `só aparecem ${agrupar === 'semana' ? 'as semanas' : 'os dias'} com movimento em conta bancária${agrupar === 'semana' ? '; a semana vai de segunda a domingo e a primeira/última podem estar cortadas pelo período' : ''}.`,
    ...(leitura.incompleto ? { incompleto: true, falhas: leitura.falhas, atencao: 'parte dos dados NÃO veio: os totais estão INCOMPLETOS.' } : {}),
  };
}

// ----------------------------------------------------------------- registro

const empresaArg = z.string().optional().describe('empresa/unidade do conector com leitura bancária (slug ou nome curto). Opcional quando só uma tem. Veja pluggy_contas.');
const dia = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

const SO_QUEM_PODE = 'Dado bancário é sensível: só para quem tem permissão de alterar cartões.';

export function registrarFerramentasPluggy(server: McpServer, ctx: ContextoPluggy, auditar?: Auditar): void {
  const ro = { readOnlyHint: true, openWorldHint: true };
  // erro que repete o pedido sai mascarado e SEM segredo: o `executar` já cuida de CPF/telefone; aqui garantimos que nem a chave nem o secret apareçam
  const seguro = <T>(nome: string, args: unknown, fn: () => Promise<T>) =>
    executar(nome, args, auditar, async () => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ErroDeEntrada) throw e;
        throw new Error(tirarSegredos(msg(e)));
      }
    });
  server.registerTool(
    'pluggy_contas',
    {
      title: 'Contas bancárias (Pluggy / Open Finance)',
      description:
        'Contas bancárias ligadas pelo Meu Pluggy (Open Finance) de uma empresa: banco, tipo (conta corrente, poupança, cartão), número mascarado (•••1234), saldo e a data da ÚLTIMA SINCRONIZAÇÃO ' +
        'de cada conexão. O Meu Pluggy atualiza 1 vez por dia: não é saldo em tempo real. Com testar=true prova as credenciais da Pluggy (uma chave nova) antes de ler. Só leitura. ' + SO_QUEM_PODE,
      inputSchema: { empresa: empresaArg, testar: z.boolean().optional().describe('true: prova o clientId/clientSecret na Pluggy') },
      annotations: ro,
    },
    (args) => seguro('pluggy_contas', args, () => pluggyContas(ctx, args)),
  );
  server.registerTool(
    'pluggy_extrato',
    {
      title: 'Extrato bancário (Pluggy / Open Finance)',
      description:
        'Lançamentos de uma empresa num período de até 90 dias (datas AAAA-MM-DD): data, descrição, valor, tipo (entrada/saída), categoria e, quando o banco informa (Pix/TED), o nome de quem pagou e de quem recebeu. ' +
        'Traz o total que entrou e o que saiu, os dados de quando foram sincronizados, e filtra por valor mínimo (em reais, em módulo), por texto (descrição ou nome) e por tipo. ' +
        'Informe `conta` (id de pluggy_contas) para uma conta só; sem ela vêm todas as contas da empresa, com cartão de crédito em bloco separado. Os dados são os da última sincronização diária, não de agora. Só leitura. ' + SO_QUEM_PODE,
      inputSchema: {
        empresa: empresaArg,
        conta: z.string().optional().describe('id da conta (de pluggy_contas); sem ele, todas as contas da empresa'),
        inicio: dia('primeiro dia'),
        fim: dia('último dia (incluso)'),
        valorMinimo: z.number().min(0).optional().describe('só lançamentos de valor (em módulo) maior ou igual, em reais'),
        texto: z.string().optional().describe('só lançamentos cuja descrição ou nome de pagador/recebedor tenha este texto (mín. 2 letras)'),
        tipo: z.enum(['entrada', 'saida']).optional(),
        maxItens: z.number().int().min(0).max(MAX_LANCAMENTOS).optional().describe('quantos lançamentos listar (padrão 50; 0 = só os totais)'),
      },
      annotations: ro,
    },
    (args) => seguro('pluggy_extrato', args, () => pluggyExtrato(ctx, args)),
  );
  server.registerTool(
    'pluggy_resumo',
    {
      title: 'Resumo do extrato por dia ou semana (Pluggy / Open Finance)',
      description:
        'Quanto entrou e saiu por DIA ou por SEMANA (segunda a domingo) das contas bancárias de uma empresa num período de até 90 dias, mais os totais e a data da última sincronização. ' +
        'Cartão de crédito fica fora dos períodos e vem em bloco próprio. Só leitura. ' + SO_QUEM_PODE,
      inputSchema: {
        empresa: empresaArg,
        conta: z.string().optional().describe('id da conta (de pluggy_contas); sem ele, todas as contas da empresa'),
        inicio: dia('primeiro dia'),
        fim: dia('último dia (incluso)'),
        agrupar: z.enum(['dia', 'semana']).optional().describe('padrão: dia'),
      },
      annotations: ro,
    },
    (args) => seguro('pluggy_resumo', args, () => pluggyResumo(ctx, args)),
  );
}

/**
 * O portão: as três ferramentas só existem para quem está na lista de quem altera cartões (`escritores`, MCP_ESCRITA_EMAILS) E quando a Pluggy está
 * ligada no servidor. Um leitor comum não as vê (nem por `tools/list`, nem por chamada direta). Devolve se registrou.
 */
export function registrarPluggySePermitido(server: McpServer, ctx: ContextoPluggy, userId: string, escritores: ReadonlySet<string>, auditar?: Auditar): boolean {
  if (!escritores.has(userId) || !ctx.fonte || !ctx.itens.length) return false;
  registrarFerramentasPluggy(server, ctx, auditar);
  return true;
}
