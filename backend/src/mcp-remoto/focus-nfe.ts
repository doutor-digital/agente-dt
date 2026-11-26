/**
 * Focus NFe no conector — NFS-e NACIONAL: o contexto (uma conta por unidade), o livro local das notas, a leitura (`focus_dados_fiscais`, `focus_notas`, `focus_nota`) e a
 * sincronização do status com a Focus. A EMISSÃO e o CANCELAMENTO (dois passos) ficam em `focus-nfe-escrita.ts`.
 *
 * TODAS as ferramentas da Focus são só de quem altera cartões (a lista de escrita do conector): a nota traz CPF, endereço e o serviço do paciente. Ninguém mais as vê.
 *
 * O que a API da Focus NÃO faz, e as respostas dizem: não lista notas da NFS-e Nacional (só consulta pela referência). Por isso `focus_notas` lista o livro LOCAL, que só tem
 * as notas que ESTE conector emitiu; nota emitida pelo painel da Focus ou pelo Asaas não aparece aqui.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import {
  ErroFocus, baseDoAmbiente, cancelarNota, consultarCnpj, consultarEmpresa, consultarNota, emitirNota, listarGatilhos, rotuloDoAmbiente, testarToken,
  type Ambiente, type CadastroPublico, type CancelamentoFocus, type ContaFocusConfig, type EmissaoAceita, type EmpresaFocus, type GatilhoFocus, type NotaFocus, type OpcoesDeChamada,
} from '../lib/integracoes/focus-nfe.js';
import { arredondar, diaLocal, dinheiro, positivo, FUSO_PADRAO } from './asaas-limites.js';
import { mascararErro } from '../lib/integracoes/mascaras.js';
import { executar } from './ferramenta.js';
import { perfilDaUnidade, type PerfilFiscal } from './focus-nfe-perfis.js';
import { acharSlug } from './unidades.js';

// ----------------------------------------------------------------- o livro local

export const STATUS_DA_NOTA = ['intencao', 'recusada', 'incerto', 'processando_autorizacao', 'autorizado', 'erro_autorizacao', 'negado', 'cancelado'] as const;
/** Notas que contam como "já existe uma igual": ainda podem virar (ou já são) nota válida. */
export const STATUS_ATIVOS: readonly string[] = ['intencao', 'incerto', 'processando_autorizacao', 'autorizado'];
/** Notas sem resposta final: vale perguntar de novo à Focus. */
export const STATUS_ABERTOS: readonly string[] = ['intencao', 'incerto', 'processando_autorizacao'];
/** Não gastam o teto de VALOR do dia: a Focus recusou ou não autorizou. */
const STATUS_SEM_VALOR: readonly string[] = ['recusada', 'erro_autorizacao', 'negado'];

/** Uma nota como o livro guarda (datas em ISO). Sem CPF, nome nem endereço: só o documento mascarado. */
export interface NotaGuardada {
  referencia: string;
  unidade: string;
  ambiente: Ambiente;
  status: string;
  serieDps: number;
  numeroDps: number;
  valorCentavos: number;
  dataCompetencia: string;
  tomadorMascarado: string;
  origem: string | null;
  chaveDuplicata: string;
  criadoPor: string;
  criadoEm: string;
  numeroNfse: string | null;
  codigoVerificacao: string | null;
  urlConsulta: string | null;
  urlDanfse: string | null;
  caminhoXml: string | null;
  emitidaEm: string | null;
  canceladaEm: string | null;
  revisao: string | null;
  ultimoEvento: string | null;
  erro: string | null;
}

export interface FiltroDeNotas {
  unidade: string;
  ambiente?: Ambiente;
  de?: Date;
  ate?: Date;
  status?: string;
  limite: number;
}

export interface ItemDoLivro {
  valorCentavos: number;
  status: string;
  em: number;
}

/** As notas das últimas 36 h da unidade e do ambiente, lidas do banco naquele instante. Só calcula; não guarda estado. */
export class LivroDeNotas {
  constructor(private itens: ItemDoLivro[] = []) {}

  /** `recusada`, `erro_autorizacao` e `negado` NÃO gastam o teto de valor; cancelada GASTA (a nota existiu e o dinheiro passou por ela). */
  somaDoDia(agora: number, fuso: string = FUSO_PADRAO): number {
    const hoje = diaLocal(agora, fuso);
    const cents = this.itens.filter((x) => !STATUS_SEM_VALOR.includes(x.status) && diaLocal(x.em, fuso) === hoje).reduce((s, x) => s + x.valorCentavos, 0);
    return cents / 100;
  }

  /** Toda tentativa conta no limite por hora (inclusive a recusada): ele existe para segurar quem martela a Focus. */
  naHora(agora: number, horaMs = 3_600_000): number {
    return this.itens.filter((x) => agora - x.em < horaMs).length;
  }
}

export interface ArmazemDeNotas {
  listar(f: FiltroDeNotas): Promise<NotaGuardada[]>;
  porReferencia(unidade: string, ambiente: Ambiente, referencia: string): Promise<NotaGuardada | null>;
  /** a nota ATIVA (intenção, incerta, em processamento ou autorizada) com esta chave de nota repetida, em qualquer época */
  ativaPorChave(unidade: string, ambiente: Ambiente, chave: string): Promise<NotaGuardada | null>;
  /** o webhook só sabe a unidade e a referência: acha a nota em qualquer ambiente */
  porReferenciaEmQualquerAmbiente(unidade: string, referencia: string): Promise<NotaGuardada | null>;
  /** leitura sem trava (consumo do dia): o que vale é a leitura feita dentro de `reservar` */
  ler(unidade: string, ambiente: Ambiente, agora: number): Promise<LivroDeNotas>;
  /**
   * Numa trava única por unidade e ambiente: lê o livro e a nota repetida, deixa `conferir` recusar, escolhe o número da DPS e grava a INTENÇÃO, tudo antes de a Focus
   * ser chamada. Referência repetida na unidade é recusada.
   */
  reservar(p: PedidoDeReserva): Promise<{ serieDps: number; numeroDps: number }>;
  atualizar(unidade: string, ambiente: Ambiente, referencia: string, patch: PatchDaNota): Promise<NotaGuardada | null>;
}

export interface PedidoDeReserva {
  unidade: string;
  ambiente: Ambiente;
  referencia: string;
  chaveDuplicata: string;
  valorCentavos: number;
  dataCompetencia: string;
  tomadorMascarado: string;
  origem: string | null;
  criadoPor: string;
  agora: number;
  serieDps: number;
  numeroInicial: number;
  /** recebe o livro e a nota ativa igual (se houver), lidos DENTRO da trava; lança ErroDeEntrada para recusar */
  conferir(livro: LivroDeNotas, repetida: NotaGuardada | null): void;
}

export interface PatchDaNota {
  status?: string;
  numeroNfse?: string | null;
  codigoVerificacao?: string | null;
  urlConsulta?: string | null;
  urlDanfse?: string | null;
  caminhoXml?: string | null;
  emitidaEm?: Date | null;
  canceladaEm?: Date | null;
  revisao?: string | null;
  ultimoEvento?: string;
  erro?: string | null;
}

// ----------------------------------------------------------------- a conta

export interface ContaFocus {
  slug: string;
  nome: string;
  ambiente: Ambiente;
  cnpj?: string;
  municipio?: string;
  serieDps?: number;
  numeroInicial: number;
  /** o que a contabilidade já informou desta unidade (focus-nfe-perfis.ts); o CNPJ e o município acima já vêm daqui quando o ambiente não os troca */
  perfil?: PerfilFiscal;
  /** a chamada pronta: o token fica na closure e NUNCA sai daqui (a conta serializada ou logada não o mostra) */
  fonte: {
    testar(): Promise<void>;
    consultar(ref: string): Promise<NotaFocus | null>;
    /** a ESCRITA: só o código de emissão/cancelamento, com portão, teto e dois passos, chama */
    emitir(ref: string, corpo: Record<string, unknown>): Promise<EmissaoAceita>;
    cancelar(ref: string, justificativa: string): Promise<CancelamentoFocus>;
    gatilhos(): Promise<GatilhoFocus[]>;
    cnpj(cnpj: string): Promise<CadastroPublico | null>;
    empresa(cnpj: string): Promise<EmpresaFocus | null>;
  };
}

export function contaFocusDaConfig(c: ContaFocusConfig, op: OpcoesDeChamada = {}, perfil: PerfilFiscal | undefined = perfilDaUnidade(c.slug)): ContaFocus {
  const cred = { token: c.token, ambiente: c.ambiente };
  const cnpj = c.cnpj ?? perfil?.cnpj;
  const municipio = c.municipio ?? perfil?.municipioIbge;
  return {
    slug: c.slug,
    nome: c.nome,
    ambiente: c.ambiente,
    ...(cnpj ? { cnpj } : {}),
    ...(municipio ? { municipio } : {}),
    ...(perfil ? { perfil } : {}),
    ...(c.serieDps !== undefined ? { serieDps: c.serieDps } : {}),
    numeroInicial: c.numeroInicial,
    fonte: {
      testar: () => testarToken(cred, op),
      consultar: (ref) => consultarNota(cred, ref, op),
      emitir: (ref, corpo) => emitirNota(cred, ref, corpo, op),
      cancelar: (ref, j) => cancelarNota(cred, ref, j, op),
      gatilhos: () => listarGatilhos(cred, op),
      cnpj: (d) => consultarCnpj(cred, d, op),
      empresa: (d) => consultarEmpresa(cred, d, op),
    },
  };
}

export interface ContextoFocus {
  contas: Map<string, ContaFocus>;
  notas: ArmazemDeNotas;
  agora: () => number;
  /** o segredo do webhook existe? (só o booleano; o segredo nunca entra no contexto) */
  webhookConfigurado: boolean;
}

export function criarContextoFocus(contas: Map<string, ContaFocus>, notas: ArmazemDeNotas, op: { agora?: () => number; webhookConfigurado?: boolean } = {}): ContextoFocus {
  return { contas, notas, agora: op.agora ?? Date.now, webhookConfigurado: op.webhookConfigurado ?? false };
}

export function resolverContaFocus(ctx: ContextoFocus, alvo: string | undefined): ContaFocus {
  if (ctx.contas.size === 0) throw new ErroDeEntrada('nenhuma unidade com a Focus NFe ligada ainda (o token fica no ambiente do servidor: FOCUS_NFE_TOKEN_<UNIDADE>, e a unidade precisa estar em FOCUS_NFE_UNIDADES).');
  const com = [...ctx.contas.keys()].join(', ');
  if (!alvo || !alvo.trim()) {
    if (ctx.contas.size === 1) return [...ctx.contas.values()][0]!;
    throw new ErroDeEntrada(`diga a unidade. Com Focus NFe: ${com}`);
  }
  const slug = acharSlug(ctx.contas.keys(), alvo);
  if (!slug) throw new ErroDeEntrada(`unidade sem Focus NFe, desconhecida ou ambígua: ${alvo}. Com Focus NFe: ${com}`);
  return ctx.contas.get(slug)!;
}

// ----------------------------------------------------------------- limites (lidos a cada uso, do ambiente)

export const LIMITES_FOCUS = { horaMs: 3_600_000, janelaLivroMs: 36 * 3_600_000, porHoraPadrao: 20, tetoNotaPadrao: 5000, tetoDiaPadrao: 20000 };

export function tetoPorNota(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.FOCUS_NFE_TETO_NOTA_REAIS) ?? LIMITES_FOCUS.tetoNotaPadrao;
}

export function tetoPorDiaFocus(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.FOCUS_NFE_TETO_DIA_REAIS) ?? LIMITES_FOCUS.tetoDiaPadrao;
}

/** Vazio = padrão; inteiro ≥ 0; 0 ou lixo = emissão DESLIGADA (mesma regra do Asaas e da InfinitePay). */
export function notasPorHora(e: NodeJS.ProcessEnv = process.env): number {
  const bruto = e.FOCUS_NFE_NOTAS_POR_HORA?.trim();
  if (!bruto) return LIMITES_FOCUS.porHoraPadrao;
  const n = Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export interface LimitesDeEmissao {
  tetoNota: () => number;
  tetoDia: () => number;
  porHora: () => number;
}

export const limitesDoAmbiente = (e: NodeJS.ProcessEnv = process.env): LimitesDeEmissao => ({ tetoNota: () => tetoPorNota(e), tetoDia: () => tetoPorDiaFocus(e), porHora: () => notasPorHora(e) });

export async function consumoDoDiaFocus(ctx: ContextoFocus, lim: LimitesDeEmissao, conta: ContaFocus) {
  const agora = ctx.agora();
  const livro = await ctx.notas.ler(conta.slug, conta.ambiente, agora);
  const usado = livro.somaDoDia(agora);
  return {
    tetoPorNota: dinheiro(lim.tetoNota()),
    tetoDoDia: dinheiro(lim.tetoDia()),
    usadoHoje: dinheiro(usado),
    restanteHoje: dinheiro(Math.max(0, arredondar(lim.tetoDia() - usado))),
    notasPorHora: lim.porHora(),
    notasNaUltimaHora: livro.naHora(agora, LIMITES_FOCUS.horaMs),
  };
}

// ----------------------------------------------------------------- sincronizar com a Focus

const dataIso = (s: string | undefined): Date | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
};

/** A mensagem de erro da autorização (sem token nem documento: o cliente da Focus já limpa), curta para caber no livro. */
export function resumoDosErros(n: NotaFocus): string | null {
  const e = n.erros?.slice(0, 3).map((x) => [x.codigo, x.mensagem, x.correcao ? `correção: ${x.correcao}` : ''].filter(Boolean).join(' ')).join(' | ');
  return e ? mascararErro(e).slice(0, 500) : null;
}

/** O patch que a resposta da Focus faz no livro, ou null se ela não muda nada (a Focus é a verdade; o corpo do webhook nunca). */
export function patchDaConsulta(atual: NotaGuardada, n: NotaFocus | null, agora: number): PatchDaNota | null {
  if (!n) {
    // A Focus não conhece a referência. Logo depois de um POST sem resposta isso ainda pode ser fila: só 30 minutos depois vale como "nunca chegou".
    // NUNCA vira `recusada` sozinha: a nota continua travando a nota repetida (emitir duas vezes é pior que pedir uma conferência). A marca de revisão avisa; quem confere no painel decide.
    if ((atual.status === 'incerto' || atual.status === 'intencao') && agora - Date.parse(atual.criadoEm) > 30 * 60_000 && atual.ultimoEvento !== 'sincronizado:nao_encontrada') {
      return { ultimoEvento: 'sincronizado:nao_encontrada', revisao: 'a Focus não conhece esta referência 30 minutos depois do pedido: provavelmente a emissão nunca chegou a ela. Confira no painel da Focus; se de fato não existe, emita de novo com outra "origem" (esta nota segue travando a repetida até lá)' };
    }
    return null;
  }
  const aberta = STATUS_ABERTOS.includes(atual.status);
  const novo = n.status;
  // do aberto vai para qualquer lugar; do autorizado só para cancelado (ou completa o que faltou: número e links); o resto não volta atrás
  const completa = atual.status === 'autorizado' && novo === 'autorizado' && (!atual.numeroNfse || !atual.urlDanfse);
  if (!aberta && !completa && !(atual.status === 'autorizado' && novo === 'cancelado')) return null;
  if (novo === atual.status && novo !== 'autorizado') return null;
  if (novo === 'autorizado' && atual.status === 'autorizado' && !completa) return null;
  if (!STATUS_DA_NOTA.includes(novo as never)) return { ultimoEvento: `sincronizado:status_desconhecido`, erro: `a Focus devolveu um status que o conector não conhece (${novo.slice(0, 40)})` };
  return {
    status: novo,
    ultimoEvento: `sincronizado:${novo}`,
    ...(n.numero ? { numeroNfse: n.numero } : {}),
    ...(n.codigoVerificacao ? { codigoVerificacao: n.codigoVerificacao } : {}),
    ...(n.urlConsulta ? { urlConsulta: n.urlConsulta } : {}),
    ...(n.urlDanfse ? { urlDanfse: n.urlDanfse } : {}),
    ...(n.caminhoXml ? { caminhoXml: n.caminhoXml } : {}),
    ...(novo === 'autorizado' && dataIso(n.dataEmissao) ? { emitidaEm: dataIso(n.dataEmissao)! } : {}),
    ...(novo === 'cancelado' ? { canceladaEm: new Date(agora) } : {}),
    ...(novo === 'erro_autorizacao' || novo === 'negado' ? { erro: resumoDosErros(n) ?? `a Focus devolveu ${novo}` } : {}),
  };
}

/** Pergunta à Focus e aplica no livro. Devolve a nota como ficou e se o STATUS mudou agora. */
export async function sincronizarNota(ctx: ContextoFocus, conta: ContaFocus, nota: NotaGuardada): Promise<{ nota: NotaGuardada; mudou: boolean; focus: NotaFocus | null }> {
  const focus = await conta.fonte.consultar(nota.referencia);
  const antes = nota.status;
  const patch = patchDaConsulta(nota, focus, ctx.agora());
  if (!patch) return { nota, mudou: false, focus };
  const atualizada = (await ctx.notas.atualizar(nota.unidade, nota.ambiente, nota.referencia, patch)) ?? nota;
  return { nota: atualizada, mudou: patch.status !== undefined && patch.status !== antes, focus };
}

// ----------------------------------------------------------------- apresentação

export const AVISO_HOMOLOGACAO = 'HOMOLOGAÇÃO: ambiente de teste da Focus, a nota NÃO tem validade fiscal.';
export const AVISO_PRODUCAO = 'PRODUÇÃO: NOTA REAL, com validade fiscal e tributária. Cancelar depende do prazo e das regras da prefeitura/Portal Nacional.';
export const avisoDoAmbiente = (a: Ambiente) => (a === 'producao' ? AVISO_PRODUCAO : AVISO_HOMOLOGACAO);

export const LIMITES_DA_API_FOCUS =
  'A API da Focus NFe não lista notas da NFS-e Nacional (só consulta pela referência): esta lista é o livro do que ESTE conector emitiu. Nota emitida pelo painel da Focus ou pelo Asaas não aparece aqui.';

export const reais = (centavos: number) => dinheiro(centavos / 100);

/** O XML da nota: a Focus devolve o CAMINHO; o endereço completo é o do ambiente + o caminho (convenção da Focus para os arquivos). */
export function urlDoXml(ambiente: Ambiente, caminho: string | null | undefined): string | null {
  return caminho && caminho.startsWith('/arquivos/') ? `${baseDoAmbiente(ambiente)}${caminho}` : null;
}

export function mostrarNota(n: NotaGuardada, completa = false) {
  return {
    referencia: n.referencia,
    ambiente: rotuloDoAmbiente(n.ambiente),
    status: n.status,
    ...(n.numeroNfse ? { numeroDaNota: n.numeroNfse } : {}),
    valor: reais(n.valorCentavos),
    competencia: n.dataCompetencia,
    tomador: n.tomadorMascarado,
    serieEnumeroDaDps: `${n.serieDps}/${n.numeroDps}`,
    ...(n.origem ? { origem: n.origem } : {}),
    criadaEm: n.criadoEm,
    criadaPor: n.criadoPor,
    ...(n.emitidaEm ? { emitidaEm: n.emitidaEm } : {}),
    ...(n.canceladaEm ? { canceladaEm: n.canceladaEm } : {}),
    ...(n.revisao ? { revisao: n.revisao } : {}),
    ...(n.erro ? { erro: n.erro } : {}),
    ...(completa
      ? {
          ...(n.codigoVerificacao ? { codigoDeVerificacao: n.codigoVerificacao } : {}),
          ...(n.urlConsulta ? { consultaNoPortal: n.urlConsulta } : {}),
          ...(n.urlDanfse ? { pdf: n.urlDanfse } : {}),
          ...(n.caminhoXml ? { xmlCaminho: n.caminhoXml, ...(urlDoXml(n.ambiente, n.caminhoXml) ? { xml: urlDoXml(n.ambiente, n.caminhoXml) } : {}) } : {}),
        }
      : {}),
  };
}

// ----------------------------------------------------------------- focus_dados_fiscais

/** O que a contabilidade ainda tem de informar a cada nota (a ferramenta de emitir recusa e diz o que falta; nada disto é suposto). O que o perfil da unidade já traz sai da lista. */
export function oQueAContabilidadeInforma(perfil?: PerfilFiscal): string[] {
  return [
    ...(perfil ? [] : ['codigoTributacaoNacional (cTribNac, 6 dígitos), a descrição do serviço e, se a prefeitura exigir, a inscrição municipal do prestador']),
    'tributacaoIss e tipoRetencaoIss: o ISS é devido? (1 = operação tributável) e é retido pelo tomador? (1 = não retido, 2 = retido pelo tomador)',
    ...(perfil?.aliquotaIss !== undefined ? [] : ['aliquotaIss: a alíquota do ISS em %, ou "parametrizada" se o município está no Sistema Nacional e a alíquota vem de lá (sem ela a nota NÃO sai)']),
    ...(perfil ? [] : ['opcaoSimplesNacional (1 não optante, 2 MEI, 3 ME/EPP)']),
    'regimeApuracaoSimples (regime de apuração do Simples, se ME/EPP) e regimeEspecialTributacao',
    'ibsCbs.situacaoTributaria e ibsCbs.classificacaoTributaria: a Focus os marca como obrigatórios (Reforma Tributária) na documentação do DPS',
    'consumidorFinal e indicadorDestinatario (Reforma Tributária; a Focus os marca como obrigatórios)',
    'percentualTotalTributosSimples OU naoInformarTotalTributos: o ambiente nacional recusa o DPS sem uma das duas (confirmado na homologação da Focus)',
    'o certificado digital A1 enviado no painel da Focus e a empresa cadastrada lá, com o token do ambiente (o conector não envia certificado)',
  ];
}

const melhor = async <T>(fn: () => Promise<T>): Promise<{ ok: true; valor: T } | { ok: false; motivo: string }> => {
  try {
    return { ok: true, valor: await fn() };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
};

export async function dadosFiscais(ctx: ContextoFocus, lim: LimitesDeEmissao, a: { unidade?: string }) {
  const c = resolverContaFocus(ctx, a.unidade);
  const faltaConfigurar: string[] = [];
  if (!c.cnpj) faltaConfigurar.push('FOCUS_NFE_CNPJ_<UNIDADE> (CNPJ do prestador; unidade sem perfil fiscal em focus-nfe-perfis.ts)');
  if (!c.municipio) faltaConfigurar.push('FOCUS_NFE_MUNICIPIO_<UNIDADE> (código IBGE do município do prestador; unidade sem perfil fiscal)');
  if (c.ambiente === 'producao' && c.serieDps === undefined) faltaConfigurar.push('FOCUS_NFE_SERIE_DPS_<UNIDADE> (a série da DPS em produção; a homologação usa a série 1)');
  const [token, cadastro, empresa, gatilhos, consumo, proximo] = await Promise.all([
    melhor(() => c.fonte.testar()),
    c.cnpj ? melhor(() => c.fonte.cnpj(c.cnpj!)) : Promise.resolve(null),
    c.cnpj ? melhor(() => c.fonte.empresa(c.cnpj!)) : Promise.resolve(null),
    melhor(() => c.fonte.gatilhos()),
    melhor(() => consumoDoDiaFocus(ctx, lim, c)),
    melhor(() => ctx.notas.listar({ unidade: c.slug, ambiente: c.ambiente, limite: 1 })),
  ]);
  const serie = c.serieDps ?? (c.ambiente === 'homologacao' ? 1 : undefined);
  const dele = empresa && empresa.ok ? empresa.valor : null;
  const serieDaFocus = dele ? (c.ambiente === 'producao' ? dele.serieNfsenProducao : dele.serieNfsenHomologacao) : undefined;
  const proximoDaFocus = dele ? (c.ambiente === 'producao' ? dele.proximoNumeroNfsenProducao : dele.proximoNumeroNfsenHomologacao) : undefined;
  const cuidados: string[] = [];
  if (token.ok === false) cuidados.push(`o token NÃO foi aceito pela Focus: ${token.motivo}`);
  if (serie !== undefined && serieDaFocus !== undefined && serieDaFocus !== serie) cuidados.push(`a série configurada no conector (${serie}) é diferente da série da NFS-e Nacional no cadastro da empresa na Focus (${serieDaFocus}): confirme com a contabilidade qual usar`);
  if (cadastro && cadastro.ok && cadastro.valor && c.municipio && cadastro.valor.codigoIbge && cadastro.valor.codigoIbge !== c.municipio) {
    cuidados.push(`o município configurado (${c.municipio}) é diferente do do cadastro público do CNPJ (${cadastro.valor.codigoIbge}): confira FOCUS_NFE_MUNICIPIO_<UNIDADE>`);
  }
  if (!ctx.webhookConfigurado) cuidados.push('FOCUS_NFE_WEBHOOK_SEGREDO ausente (32+ caracteres): o aviso automático de nota autorizada está desligado; o status só atualiza quando alguém consulta com focus_nota');
  const meuGatilho = gatilhos.ok ? gatilhos.valor.some((g) => g.event === 'nfsen' && g.url.includes(`/focus-nfe/webhook/${encodeURIComponent(c.slug)}/`)) : null;
  return {
    unidade: c.slug,
    nome: c.nome,
    ambiente: rotuloDoAmbiente(c.ambiente),
    avisoDoAmbiente: avisoDoAmbiente(c.ambiente),
    tipoDeNota: 'NFS-e Nacional (rota /v2/nfsen da Focus)',
    configuracaoNoConector: {
      tokenConfigurado: true,
      cnpjDoPrestador: c.cnpj ?? null,
      municipioIbge: c.municipio ?? null,
      serieDaDps: serie ?? null,
      primeiroNumeroDaDps: c.numeroInicial,
      jaEmitidasPeloConectorNesteAmbiente: proximo.ok ? (proximo.valor.length ? 'sim (veja focus_notas)' : 'nenhuma') : 'não consegui ler',
    },
    tokenNaFocus: token.ok ? 'aceito' : { recusado: token.motivo },
    cadastroPublicoDoCnpj: cadastro === null ? 'CNPJ não configurado' : cadastro.ok ? (cadastro.valor ?? 'a consulta pública de CNPJ da Focus não respondeu para este token e ambiente (em homologação ela não existe)') : { indisponivel: cadastro.motivo },
    empresaNaFocus:
      empresa === null
        ? 'CNPJ não configurado'
        : empresa.ok
          ? (empresa.valor ?? 'o token desta unidade não enxerga o cadastro da empresa (a API de Empresas só existe em produção e pode ser só do token principal da conta): confira no painel da Focus se a NFS-e Nacional está habilitada e o certificado A1 enviado')
          : { indisponivel: empresa.motivo },
    ...(dele && proximoDaFocus !== undefined ? { proximoNumeroNaFocus: proximoDaFocus } : {}),
    webhook: { segredoConfigurado: ctx.webhookConfigurado, cadastradoNaFocus: meuGatilho },
    limites: { ...lim_(lim), consumoDeHoje: consumo.ok ? consumo.valor : { indisponivel: consumo.motivo } },
    faltaConfigurar,
    cuidados,
    perfilFiscal: c.perfil ?? 'esta unidade não tem perfil fiscal em focus-nfe-perfis.ts: a emissão pede tudo a cada nota',
    oQueAContabilidadeInforma: oQueAContabilidadeInforma(c.perfil),
    limitesDaApi: LIMITES_DA_API_FOCUS,
  };
}

const lim_ = (lim: LimitesDeEmissao) => ({ tetoPorNota: dinheiro(lim.tetoNota()), tetoDoDia: dinheiro(lim.tetoDia()), notasPorHora: lim.porHora() });

// ----------------------------------------------------------------- focus_notas e focus_nota

const MAX_NOTAS = 100;
const MAX_ATUALIZAR = 10;

const inicioDoDia = (d: string) => new Date(`${d}T00:00:00-03:00`);
const fimDoDia = (d: string) => new Date(`${d}T23:59:59.999-03:00`);

export async function listarNotas(ctx: ContextoFocus, a: { unidade?: string; de?: string; ate?: string; status?: string; limite?: number; atualizar?: boolean }) {
  const c = resolverContaFocus(ctx, a.unidade);
  const de = a.de ? validarData(a.de, 'de') : undefined;
  const ate = a.ate ? validarData(a.ate, 'ate') : undefined;
  if (de && ate && de > ate) throw new ErroDeEntrada('o período está invertido: "de" vem depois de "ate"');
  if (a.status && !STATUS_DA_NOTA.includes(a.status as never)) throw new ErroDeEntrada(`status inválido. Use um destes: ${STATUS_DA_NOTA.join(', ')}`);
  const limite = Math.min(Math.max(1, a.limite ?? 50), MAX_NOTAS);
  let notas = await ctx.notas.listar({ unidade: c.slug, ambiente: c.ambiente, ...(de ? { de: inicioDoDia(de) } : {}), ...(ate ? { ate: fimDoDia(ate) } : {}), ...(a.status ? { status: a.status } : {}), limite });
  let atualizadas = 0;
  const falhas: string[] = [];
  if (a.atualizar) {
    const abertas = notas.filter((n) => STATUS_ABERTOS.includes(n.status)).slice(0, MAX_ATUALIZAR);
    for (const n of abertas) {
      try {
        const r = await sincronizarNota(ctx, c, n);
        if (r.mudou) atualizadas++;
        notas = notas.map((x) => (x.referencia === n.referencia ? r.nota : x));
      } catch (e) {
        falhas.push(`${n.referencia}: ${e instanceof Error ? e.message : 'falhou'}`.slice(0, 160));
      }
    }
  }
  const total = notas.filter((n) => STATUS_ATIVOS.includes(n.status) && n.status !== 'intencao').reduce((s, n) => s + n.valorCentavos, 0);
  return {
    unidade: c.slug,
    ambiente: rotuloDoAmbiente(c.ambiente),
    avisoDoAmbiente: avisoDoAmbiente(c.ambiente),
    quantidade: notas.length,
    ...(notas.length >= limite ? { aviso: `mostrei só as ${limite} mais recentes: estreite o período` } : {}),
    somaDasNotasAtivas: reais(total),
    notas: notas.map((n) => mostrarNota(n)),
    ...(a.atualizar ? { atualizadasAgora: atualizadas, ...(falhas.length ? { naoConsegui: falhas } : {}) } : {}),
    limitesDaApi: LIMITES_DA_API_FOCUS,
  };
}

export async function verNota(ctx: ContextoFocus, a: { unidade?: string; referencia: string }) {
  const c = resolverContaFocus(ctx, a.unidade);
  const ref = a.referencia.trim();
  const local = await ctx.notas.porReferencia(c.slug, c.ambiente, ref);
  if (!local) throw new ErroDeEntrada(`não há nota com a referência ${ref} no livro do conector (${rotuloDoAmbiente(c.ambiente)}). Veja as referências com focus_notas.`);
  let atual = local;
  let aviso: string | undefined;
  try {
    atual = (await sincronizarNota(ctx, c, local)).nota;
  } catch (e) {
    aviso = `não consegui perguntar à Focus agora (${e instanceof Error ? e.message : 'falhou'}): estes são os dados do livro local`;
  }
  return {
    unidade: c.slug,
    avisoDoAmbiente: avisoDoAmbiente(c.ambiente),
    nota: mostrarNota(atual, true),
    ...(atual.status === 'processando_autorizacao' ? { aviso: 'a nota ainda está sendo processada pelo ambiente nacional: consulte de novo em instantes' } : {}),
    ...(atual.status === 'incerto' ? { aviso: 'o resultado da emissão ficou INCERTO: a nota PODE ter sido emitida. Não emita outra igual antes de conferir no painel da Focus.' } : {}),
    ...(aviso ? { avisoDaConsulta: aviso } : {}),
  };
}

// ----------------------------------------------------------------- registro das ferramentas de leitura

export function registrarLeituraFocus(server: McpServer, ctx: ContextoFocus, lim: LimitesDeEmissao, auditar: Auditar): void {
  const unidade = z.string().optional().describe('unidade com Focus NFe ligada (slug ou nome curto); opcional se só houver uma');
  server.registerTool(
    'focus_dados_fiscais',
    {
      title: 'Dados fiscais da unidade na Focus NFe',
      description:
        'O que a unidade tem configurado para emitir NFS-e NACIONAL pela Focus NFe: ambiente (HOMOLOGAÇÃO ou PRODUÇÃO), se o token é aceito, CNPJ, município, série da DPS, cadastro público do CNPJ ' +
        '(situação e Simples Nacional), o cadastro da empresa na Focus (certificado, NFS-e habilitada) quando o token o enxerga, se o webhook está cadastrado, os tetos e o consumo de hoje, ' +
        'o que ainda falta configurar e o que a contabilidade precisa informar a cada nota. Não emite nada. Só para quem altera cartões.',
      inputSchema: { unidade },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => executar('focus_dados_fiscais', args, auditar, () => dadosFiscais(ctx, lim, args)),
  );
  server.registerTool(
    'focus_notas',
    {
      title: 'Notas fiscais emitidas pelo conector (Focus NFe)',
      description:
        'Lista as NFS-e que ESTE conector emitiu pela Focus NFe, por período e status (a Focus não tem lista de notas da NFS-e Nacional: nota emitida pelo painel ou pelo Asaas não aparece). ' +
        'Mostra referência, ambiente (HOMOLOGAÇÃO ou PRODUÇÃO), status, valor, competência e o documento do tomador MASCARADO. `atualizar=true` pergunta à Focus o status das ainda em processamento. Só para quem altera cartões.',
      inputSchema: {
        unidade,
        de: z.string().optional().describe('início do período, AAAA-MM-DD (data em que a nota foi criada, horário de Brasília)'),
        ate: z.string().optional().describe('fim do período, AAAA-MM-DD'),
        status: z.enum(STATUS_DA_NOTA).optional().describe('só as notas com este status'),
        limite: z.number().int().min(1).max(MAX_NOTAS).optional().describe(`quantas (padrão 50, máximo ${MAX_NOTAS})`),
        atualizar: z.boolean().optional().describe(`true = pergunta à Focus o status das notas ainda em processamento (até ${MAX_ATUALIZAR})`),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => executar('focus_notas', args, auditar, () => listarNotas(ctx, args)),
  );
  server.registerTool(
    'focus_nota',
    {
      title: 'Uma nota fiscal (Focus NFe)',
      description:
        'Uma NFS-e pela referência: pergunta o status à Focus e devolve número, código de verificação e os links da consulta no portal, do PDF (DANFSe) e do XML. Os links mostram CPF e endereço do ' +
        'paciente: não os cole em lugar público. Só para quem altera cartões.',
      inputSchema: { unidade, referencia: z.string().min(1).max(50).describe('a referência da nota (veja em focus_notas)') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => executar('focus_nota', args, auditar, () => verNota(ctx, args)),
  );
}

export { ErroFocus };
