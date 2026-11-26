/**
 * Nota fiscal de serviço (NFS-e NACIONAL) pela Focus NFe, pelo claude.ai: EMITIR e CANCELAR, em DOIS passos (o mesmo desenho do Asaas, para notas que NÃO passam por ele:
 * InfinitePay, Pix direto, maquininha):
 *
 *   focus_preparar_nota  → confere tudo, NÃO chama a Focus para escrever, mostra o resumo COMPLETO (com o ambiente em maiúsculas) e devolve um código;
 *   focus_confirmar_nota → com o código (uso ÚNICO, 15 min, só quem preparou) é que chama a Focus: POST /v2/nfsen (emitir) ou DELETE /v2/nfsen/{ref} (cancelar).
 *
 * Regras que não se negociam aqui:
 *   - NUNCA supor alíquota, retenção, regime nem código de serviço. O que a pessoa não disse (e o perfil fiscal da unidade, informado pelo João, não traz) é PERGUNTADO:
 *     o preparar recusa e lista TUDO o que falta de uma vez. Só o que o perfil traz (focus-nfe-perfis.ts) tem valor padrão, e o resumo mostra de onde veio cada dado.
 *   - Só HOMOLOGAÇÃO por padrão (FOCUS_NFE_AMBIENTE_<UNIDADE>); produção só quando o João a liga, e o resumo e o aviso dizem PRODUÇÃO — NOTA REAL.
 *   - Nota repetida NUNCA: a mesma unidade, ambiente, documento do tomador, valor, competência e origem não emite duas vezes (a trava vale dentro do banco, numa transação).
 *     Para uma segunda nota igual de propósito, a `origem` precisa ser outra (ex. o id da venda).
 *   - A emissão NUNCA se repete sozinha: sem resposta clara da Focus o resultado é INCERTO (a nota PODE existir) e o aviso ao João sai na hora.
 *   - A INTENÇÃO (referência, série, número da DPS) é gravada ANTES de chamar a Focus; teto por nota e por dia, notas por hora, uma emissão por vez por unidade.
 *   - CPF, nome e endereço do paciente passam só pela memória do pedido: o livro guarda o documento MASCARADO, a auditoria e o log nunca os veem.
 *   - Cada emissão e cada cancelamento avisam o João no Telegram (sem dado do paciente).
 *
 * PONTO DE ENCAIXE DA EMISSÃO AUTOMÁTICA (a regra do gatilho ainda não foi decidida: pagamento ou «ATENDIDO»): `emitirNotaConfirmada` recebe o pedido JÁ validado (`NotaValidada`,
 * montado por `validarEmissao`) e faz reserva, POST, conferência e aviso, sem saber quem chamou. O caminho automático monta a `NotaValidada` com o perfil fiscal e chama a mesma função;
 * o confirmar manual é só mais um chamador. Nada automático existe neste arquivo.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { ErroFocus, rotuloDoAmbiente, type Ambiente } from '../lib/integracoes/focus-nfe.js';
import { cnpjValido, cpfValido } from '../lib/integracoes/mascaras.js';
import { diaLocal, dinheiro, mascararDoc, mascararEmail, arredondar } from './asaas-limites.js';
import { mascararErro } from '../lib/integracoes/mascaras.js';
import { executar } from './ferramenta.js';
import {
  LIMITES_FOCUS, LivroDeNotas, SEM_NUMERO_DA_DPS, avisoDoAmbiente, consumoDoDiaFocus, mostrarNota, numeroMinimoDaFocus, registrarLeituraFocus, resolverContaFocus, sincronizarNota,
  type ContaFocus, type ContextoFocus, type LimitesDeEmissao, type NotaGuardada,
} from './focus-nfe.js';
import { temDadoPessoal } from './infinitepay-escrita.js';

export const VALIDADE_PEDIDO_MS = 15 * 60_000;
const MAX_PENDENTES = 200;
/** A Focus recusou de imediato (nada foi emitido): o resto é resultado incerto. */
const RECUSA_CERTA = new Set([400, 401, 403, 404, 422, 429]);

// ----------------------------------------------------------------- o pedido e a pendência

export interface TomadorPedido {
  cpf?: string;
  cnpj?: string;
  nome?: string;
  email?: string;
  telefone?: string;
  endereco?: { cep?: string; codigoMunicipioIbge?: string; logradouro?: string; numero?: string; bairro?: string; complemento?: string };
}

export interface FiscalPedido {
  codigoTributacaoNacional?: string;
  codigoTributacaoMunicipal?: string;
  codigoNbs?: string;
  inscricaoMunicipalPrestador?: string;
  tributacaoIss?: number;
  tipoRetencaoIss?: number;
  aliquotaIss?: number | 'parametrizada';
  opcaoSimplesNacional?: number;
  regimeApuracaoSimples?: number;
  regimeEspecialTributacao?: number;
  ibsCbs?: { situacaoTributaria?: string; classificacaoTributaria?: string };
  consumidorFinal?: boolean;
  indicadorDestinatario?: number;
  /** Lei 12.741: o total aproximado de tributos (alíquota do Simples, em %). Uma das duas é obrigatória no ambiente nacional */
  percentualTotalTributosSimples?: number;
  naoInformarTotalTributos?: boolean;
  informacoesComplementares?: string;
}

export interface PedidoDePreparo {
  unidade?: string;
  acao: 'emitir' | 'cancelar';
  tomador?: TomadorPedido;
  valor?: number;
  descricao?: string;
  /** AAAA-MM-DD */
  dataCompetencia?: string;
  /** de onde sai a nota (id da venda, do link, do Pix), sem dado pessoal */
  origem?: string;
  fiscal?: FiscalPedido;
  /** cancelar */
  referencia?: string;
  justificativa?: string;
}

/** A nota JÁ validada: o que o confirmar (manual) e a emissão automática (futura) entregam a `emitirNotaConfirmada`. Sem número, série nem data de emissão: nascem na hora. */
export interface NotaValidada {
  corpo: Record<string, unknown>;
  valorCentavos: number;
  dataCompetencia: string;
  tomadorMascarado: string;
  /** só para a chave de nota repetida; nunca vai ao livro nem a log */
  tomadorDocumento: string;
  origem: string | null;
}

type PedidoGuardado =
  | { acao: 'emitir'; usuario: string; unidade: string; ambiente: Ambiente; nota: NotaValidada; resumo: unknown }
  | { acao: 'cancelar'; usuario: string; unidade: string; ambiente: Ambiente; referencia: string; justificativa: string; statusAntes: string; valorCentavos: number; resumo: unknown };

export class PendentesFocus {
  private itens = new Map<string, PedidoGuardado & { criadoEm: number }>();
  constructor(private agora: () => number = Date.now) {}

  guardar(p: PedidoGuardado): { codigo: string; expiraEm: string } {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > VALIDADE_PEDIDO_MS) this.itens.delete(k);
    if (this.itens.size >= MAX_PENDENTES) throw new ErroDeEntrada('pedidos de nota fiscal demais esperando confirmação: confirme ou espere vencer (15 minutos)');
    const codigo = randomBytes(6).toString('hex').toUpperCase();
    const criadoEm = this.agora();
    this.itens.set(codigo, { ...p, criadoEm });
    return { codigo, expiraEm: new Date(criadoEm + VALIDADE_PEDIDO_MS).toISOString() };
  }

  /** Tira o pedido (uso ÚNICO). Código de outra pessoa NÃO é gasto: quem preparou ainda pode confirmar. */
  tirar(codigo: string, usuario: string): PedidoGuardado & { criadoEm: number } {
    const chave = codigo.trim().toUpperCase();
    const p = this.itens.get(chave);
    if (!p) throw new ErroDeEntrada('código de confirmação desconhecido ou já usado: prepare a nota de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    this.itens.delete(chave);
    if (this.agora() - p.criadoEm > VALIDADE_PEDIDO_MS) throw new ErroDeEntrada('o código venceu (15 minutos): prepare a nota de novo');
    return p;
  }

  get pendentes(): number {
    return this.itens.size;
  }
}

export interface EstadoEscritaFocus {
  agora: () => number;
  limites: LimitesDeEmissao;
  /** FOCUS_NFE_UNIDADES (lida a cada uso) */
  unidades: () => Set<string>;
  /** manda o aviso (Telegram); devolve se saiu. Nunca lança. */
  alertar: (texto: string) => Promise<boolean>;
  pendentes: PendentesFocus;
  /** uma emissão por vez POR UNIDADE neste processo; entre processos quem segura é a trava do banco */
  filas: Map<string, Promise<unknown>>;
}

export function criarEscritaFocus(o: Partial<Omit<EstadoEscritaFocus, 'filas' | 'pendentes'>> & { limites: LimitesDeEmissao }): EstadoEscritaFocus {
  const agora = o.agora ?? Date.now;
  return { agora, limites: o.limites, unidades: o.unidades ?? (() => new Set()), alertar: o.alertar ?? (async () => false), pendentes: new PendentesFocus(agora), filas: new Map() };
}

export interface QuemFocus {
  id: string;
  email?: string;
  clientId?: string;
}

// ----------------------------------------------------------------- validação do pedido

const digitos = (s: string) => s.replace(/\D/g, '');
const pct = (n: number) => `${String(n).replace('.', ',')}%`;
const SIM_NAO = (b: boolean) => (b ? 'sim' : 'não');
const DE_QUEM_PEDIU = 'informado por quem pediu';
const doPerfil = (p: { origem: string } | undefined) => `perfil fiscal da unidade (${p?.origem ?? 'origem não registrada'})`;

const NOMES_DA_OPCAO_SIMPLES: Record<number, string> = { 1: 'não optante', 2: 'optante MEI', 3: 'optante ME/EPP' };
const NOMES_DA_RETENCAO: Record<number, string> = { 1: 'ISS NÃO retido', 2: 'ISS retido pelo tomador' };
const REGIMES_ESPECIAIS = new Set([0, 1, 2, 3, 4, 5, 6, 9]);
const NOMES_DO_REGIME_ESPECIAL: Record<number, string> = { 0: 'nenhum', 1: 'ato cooperado', 2: 'estimativa', 3: 'microempresa municipal', 4: 'notário ou registrador', 5: 'profissional autônomo', 6: 'sociedade de profissionais', 9: 'outros' };
const NOMES_DO_REGIME_SIMPLES: Record<number, string> = {
  1: 'tributos federais e municipal apurados pelo Simples Nacional',
  2: 'tributos federais pelo Simples e ISSQN por fora do Simples',
  3: 'tributos federais e municipal por fora do Simples',
};

function inteiroEm(v: unknown, validos: ReadonlySet<number> | number[]): number | undefined {
  const set = validos instanceof Set ? validos : new Set(validos);
  return typeof v === 'number' && Number.isInteger(v) && set.has(v) ? v : undefined;
}

function aliquota(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new ErroDeEntrada('aliquotaIss: informe a alíquota em %, um número de 0 a 100 (ex. 2 ou 2.5), ou "parametrizada"');
  if (Math.abs(Math.round(v * 10_000) / 10_000 - v) > 1e-9) throw new ErroDeEntrada('aliquotaIss: no máximo 4 casas decimais');
  return v;
}

function valorEmCentavos(valor: unknown): number {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) throw new ErroDeEntrada('valor: informe o valor da nota em reais, maior que zero');
  const c = Math.round(valor * 100);
  if (Math.abs(c - valor * 100) > 1e-6) throw new ErroDeEntrada('valor: no máximo 2 casas decimais (centavos)');
  return c;
}

export function textoLimpo(bruto: string, campo: string, min: number, max: number): string {
  const t = bruto.replace(/\s+/g, ' ').trim();
  if (t.length < min) throw new ErroDeEntrada(`${campo}: precisa ter ao menos ${min} caracteres`);
  if (t.length > max) throw new ErroDeEntrada(`${campo}: passa de ${max} caracteres`);
  // a mensagem NÃO repete o texto: ele pode ser justamente o documento
  if (temDadoPessoal(t) || /@/.test(t) || /https?:\/\//i.test(t)) throw new ErroDeEntrada(`${campo}: não pode ter CPF, telefone, e-mail nem endereço de site (sai na nota e no livro). Tire esse trecho e tente de novo.`);
  return t;
}

export function chaveDeNotaRepetida(unidade: string, ambiente: Ambiente, documento: string, valorCentavos: number, competencia: string, origem: string | null): string {
  return createHash('sha256').update([unidade, ambiente, documento, valorCentavos, competencia, (origem ?? '').toLowerCase()].join('|')).digest('hex').slice(0, 32);
}

export interface ResultadoDaValidacao {
  nota: NotaValidada;
  resumo: Record<string, unknown>;
  avisos: string[];
}

/**
 * Valida o pedido de EMISSÃO e monta o DPS (sem série, número nem data de emissão). Junta TUDO o que falta e recusa de uma vez, para a pessoa levar uma lista só à contabilidade.
 * Pura (sem rede): quem confere o cadastro público do CNPJ e o livro é o `prepararEmissao`.
 */
export function validarEmissao(conta: ContaFocus, a: PedidoDePreparo, hoje: string): ResultadoDaValidacao {
  const faltam: string[] = [];
  const perfil = conta.perfil;
  const DO_PERFIL = doPerfil(perfil);
  const avisos: string[] = [];
  const f = a.fiscal ?? {};
  const t = a.tomador ?? {};

  if (conta.conflitoDePerfil) throw new ErroDeEntrada(`${conta.conflitoDePerfil} Nada foi preparado.`);
  if (!conta.cnpj || !conta.municipio) throw new ErroDeEntrada(`a unidade ${conta.slug} não tem CNPJ e município do prestador configurados (FOCUS_NFE_CNPJ_… e FOCUS_NFE_MUNICIPIO_…, ou um perfil fiscal): o João configura no servidor. Nada foi preparado.`);
  if (conta.ambiente === 'producao' && conta.serieDps === undefined) throw new ErroDeEntrada(`a unidade ${conta.slug} está em PRODUÇÃO sem a série da DPS (FOCUS_NFE_SERIE_DPS_…): o João e a contabilidade escolhem a série. Nada foi preparado.`);

  // ---- tomador
  const docBruto = [t.cpf, t.cnpj].filter((x) => x && x.trim());
  let documento = '';
  let docTipo: 'cpf' | 'cnpj' = 'cpf';
  if (docBruto.length === 0) faltam.push('tomador.cpf (ou tomador.cnpj): o documento de quem recebe a nota');
  else if (docBruto.length > 1) throw new ErroDeEntrada('tomador: informe só o CPF OU só o CNPJ, não os dois');
  else {
    documento = digitos(t.cpf?.trim() ? t.cpf : t.cnpj!);
    docTipo = t.cpf?.trim() ? 'cpf' : 'cnpj';
    if (docTipo === 'cpf' && !(documento.length === 11 && cpfValido(documento))) throw new ErroDeEntrada('tomador.cpf: CPF inválido (dígitos verificadores não conferem). Nada foi preparado.');
    if (docTipo === 'cnpj' && !(documento.length === 14 && cnpjValido(documento))) throw new ErroDeEntrada('tomador.cnpj: CNPJ inválido (dígitos verificadores não conferem). Nada foi preparado.');
  }
  if (!t.nome?.trim()) faltam.push('tomador.nome: o nome (ou razão social) de quem recebe a nota');
  const nome = t.nome?.trim() ? textoLimpoNome(t.nome) : '';
  const email = t.email?.trim() ? emailValido(t.email) : undefined;
  const telefone = t.telefone?.trim() ? telefoneValido(t.telefone) : undefined;
  const end = t.endereco && Object.values(t.endereco).some((v) => v && String(v).trim()) ? enderecoValido(t.endereco) : undefined;
  if (!end) avisos.push('o tomador está sem endereço: o padrão nacional aceita nota sem ele em geral, mas se a Focus ou a prefeitura recusarem, informe o endereço em tomador.endereco');

  // ---- valor, texto, competência
  let valorCentavos = 0;
  if (a.valor === undefined) faltam.push('valor: o valor da nota em reais');
  else valorCentavos = valorEmCentavos(a.valor);
  const textoDaDescricao = a.descricao?.trim() ? a.descricao : perfil?.descricaoDoServico;
  if (!textoDaDescricao) faltam.push('descricao: o texto do serviço que sai na nota');
  const descricao = textoDaDescricao ? textoLimpo(textoDaDescricao, 'descricao', 3, 1000) : '';
  const informacoes = f.informacoesComplementares?.trim() ? textoLimpo(f.informacoesComplementares, 'fiscal.informacoesComplementares', 3, 2000) : undefined;
  let competencia = '';
  if (!a.dataCompetencia?.trim()) faltam.push('dataCompetencia: a data em que o serviço foi prestado (AAAA-MM-DD)');
  else {
    competencia = validarData(a.dataCompetencia.trim(), 'dataCompetencia');
    if (competencia > hoje) throw new ErroDeEntrada(`dataCompetencia ${competencia} é futura (hoje é ${hoje}): a competência é a do serviço já prestado. Nada foi preparado.`);
  }
  const origem = a.origem?.trim() ? textoLimpo(a.origem, 'origem', 1, 60) : null;

  // ---- fiscal: o perfil traz o que o João já informou; o resto vem da pessoa
  const cTribBruto = f.codigoTributacaoNacional?.trim() ? f.codigoTributacaoNacional : perfil?.codigoTributacaoNacional;
  const codigoTrib = cTribBruto ? digitos(cTribBruto) : '';
  if (!cTribBruto) faltam.push('fiscal.codigoTributacaoNacional: o código de tributação nacional do serviço (cTribNac, 6 dígitos, ex. 040802)');
  else if (codigoTrib.length !== 6) throw new ErroDeEntrada('fiscal.codigoTributacaoNacional: o código tem 6 dígitos (ex. 04.08.02 ou 040802). Nada foi preparado.');
  const nbsBruto = f.codigoNbs?.trim() ? f.codigoNbs : perfil?.codigoNbs;
  const nbs = nbsBruto ? digitos(nbsBruto) : undefined;
  if (nbs !== undefined && nbs.length !== 9) throw new ErroDeEntrada('fiscal.codigoNbs: o NBS tem 9 dígitos (ex. 1.2301.92.00 ou 123019200). Nada foi preparado.');
  const imBruto = f.inscricaoMunicipalPrestador?.trim() ? f.inscricaoMunicipalPrestador.trim() : perfil?.inscricaoMunicipal;
  if (imBruto !== undefined && !/^[A-Za-z0-9]{1,15}$/.test(imBruto)) throw new ErroDeEntrada('fiscal.inscricaoMunicipalPrestador: até 15 letras e números. Nada foi preparado.');
  const tribMunicipal = f.codigoTributacaoMunicipal?.trim();
  if (tribMunicipal !== undefined && !/^[A-Za-z0-9]{1,3}$/.test(tribMunicipal)) throw new ErroDeEntrada('fiscal.codigoTributacaoMunicipal: até 3 letras e números. Nada foi preparado.');

  let tributacao: number | undefined;
  if (f.tributacaoIss === undefined) faltam.push('fiscal.tributacaoIss: o ISS é devido? 1 = operação tributável (a única que esta versão emite)');
  else {
    tributacao = inteiroEm(f.tributacaoIss, [1, 2, 3, 4]);
    if (tributacao === undefined) throw new ErroDeEntrada('fiscal.tributacaoIss: use 1 (operação tributável), 2 (imunidade), 3 (exportação) ou 4 (não incidência)');
    if (tributacao !== 1) throw new ErroDeEntrada('fiscal.tributacaoIss: esta versão só emite operação TRIBUTÁVEL (1); imunidade, exportação e não incidência pedem campos que ainda não foram integrados. Emita pelo painel da Focus. Nada foi preparado.');
  }
  let retencao: number | undefined;
  if (f.tipoRetencaoIss === undefined) faltam.push('fiscal.tipoRetencaoIss: o ISS é retido? 1 = não retido, 2 = retido pelo tomador');
  else {
    retencao = inteiroEm(f.tipoRetencaoIss, [1, 2, 3]);
    if (retencao === undefined) throw new ErroDeEntrada('fiscal.tipoRetencaoIss: use 1 (não retido) ou 2 (retido pelo tomador)');
    if (retencao === 3) throw new ErroDeEntrada('fiscal.tipoRetencaoIss: retenção pelo intermediário pede os dados do intermediário, que esta versão não integra. Nada foi preparado.');
  }
  // a alíquota do ISS NUNCA é suposta: vem da pessoa, ou do perfil da unidade quando a unidade a decidiu e registrou lá (Açailândia: 0, Simples Nacional)
  let aliq: number | 'parametrizada' | undefined;
  const aliqDoPerfil = perfil?.aliquotaIss;
  const aliqBruta = f.aliquotaIss !== undefined ? f.aliquotaIss : aliqDoPerfil;
  if (aliqBruta === undefined) faltam.push('fiscal.aliquotaIss: a alíquota do ISS em % (a contabilidade informa), ou "parametrizada" se a alíquota vem do Sistema Nacional');
  else aliq = aliqBruta === 'parametrizada' ? 'parametrizada' : aliquota(aliqBruta);

  const opcaoDada = f.opcaoSimplesNacional !== undefined;
  const opcao = opcaoDada ? inteiroEm(f.opcaoSimplesNacional, [1, 2, 3]) : perfil?.opcaoSimplesNacional;
  if (opcaoDada && opcao === undefined) throw new ErroDeEntrada('fiscal.opcaoSimplesNacional: use 1 (não optante), 2 (MEI) ou 3 (ME/EPP)');
  if (opcao === undefined) faltam.push('fiscal.opcaoSimplesNacional: 1 = não optante do Simples, 2 = MEI, 3 = ME/EPP');
  let regSimples: number | undefined;
  if (opcao === 3) {
    if (f.regimeApuracaoSimples === undefined) faltam.push('fiscal.regimeApuracaoSimples: o regime de apuração do Simples para ME/EPP (1 = federais e municipal pelo Simples; 2 = federais pelo Simples e ISSQN por fora; 3 = tudo por fora)');
    else {
      regSimples = inteiroEm(f.regimeApuracaoSimples, [1, 2, 3]);
      if (regSimples === undefined) throw new ErroDeEntrada('fiscal.regimeApuracaoSimples: use 1, 2 ou 3');
    }
  }
  let regEspecial: number | undefined;
  if (f.regimeEspecialTributacao === undefined) faltam.push('fiscal.regimeEspecialTributacao: o regime especial de tributação municipal (0 = nenhum; 1 ato cooperado; 2 estimativa; 3 microempresa municipal; 4 notário/registrador; 5 autônomo; 6 sociedade de profissionais; 9 outros)');
  else {
    regEspecial = inteiroEm(f.regimeEspecialTributacao, REGIMES_ESPECIAIS);
    if (regEspecial === undefined) throw new ErroDeEntrada('fiscal.regimeEspecialTributacao: use 0, 1, 2, 3, 4, 5, 6 ou 9');
  }
  const cst = f.ibsCbs?.situacaoTributaria?.trim();
  const cClass = f.ibsCbs?.classificacaoTributaria?.trim();
  if (!cst) faltam.push('fiscal.ibsCbs.situacaoTributaria: o CST do IBS/CBS (3 dígitos); a Focus o marca como obrigatório (Reforma Tributária)');
  else if (!/^\d{3}$/.test(cst)) throw new ErroDeEntrada('fiscal.ibsCbs.situacaoTributaria: o CST tem 3 dígitos. Nada foi preparado.');
  if (!cClass) faltam.push('fiscal.ibsCbs.classificacaoTributaria: o cClassTrib do IBS/CBS (6 dígitos); a Focus o marca como obrigatório (Reforma Tributária)');
  else if (!/^\d{6}$/.test(cClass)) throw new ErroDeEntrada('fiscal.ibsCbs.classificacaoTributaria: o cClassTrib tem 6 dígitos. Nada foi preparado.');
  if (typeof f.consumidorFinal !== 'boolean') faltam.push('fiscal.consumidorFinal: a operação é de uso ou consumo pessoal do tomador? true ou false (Reforma Tributária; obrigatório na Focus)');
  let indDest: number | undefined;
  if (f.indicadorDestinatario === undefined) faltam.push('fiscal.indicadorDestinatario: 0 = o destinatário é o próprio tomador (Reforma Tributária; obrigatório na Focus)');
  else {
    indDest = inteiroEm(f.indicadorDestinatario, [0, 1]);
    if (indDest === undefined) throw new ErroDeEntrada('fiscal.indicadorDestinatario: use 0 ou 1');
    if (indDest === 1) throw new ErroDeEntrada('fiscal.indicadorDestinatario: 1 (destinatário diferente do tomador) pede os dados do destinatário, que esta versão não integra. Nada foi preparado.');
  }

  // o ambiente nacional recusa o DPS sem o grupo de total de tributos (verificado na homologação da Focus: "Element trib: Missing child element(s)")
  const pTot = f.percentualTotalTributosSimples;
  const naoInformar = f.naoInformarTotalTributos === true;
  if (pTot === undefined && !naoInformar) faltam.push('fiscal.percentualTotalTributosSimples (o total aproximado de tributos da alíquota do Simples, em %, Lei 12.741) OU fiscal.naoInformarTotalTributos=true: o ambiente nacional recusa a nota sem uma das duas; é escolha da contabilidade');
  else if (pTot !== undefined && naoInformar) throw new ErroDeEntrada('fiscal: informe percentualTotalTributosSimples OU naoInformarTotalTributos, não os dois');
  else if (pTot !== undefined) aliquota(pTot);

  if (faltam.length) {
    throw new ErroDeEntrada(
      `faltam dados que eu NÃO posso supor: ${faltam.map((x, i) => `${i + 1}) ${x}`).join('; ')}. Pergunte à pessoa (ou à contabilidade da clínica) e prepare de novo. Nada foi preparado.`,
    );
  }

  // ---- o corpo do DPS (campos da documentação da Focus; série, número e data de emissão entram na hora de emitir)
  const corpo: Record<string, unknown> = {
    data_competencia: competencia,
    emitente_dps: 1,
    codigo_municipio_emissora: Number(conta.municipio),
    cnpj_prestador: conta.cnpj,
    ...(imBruto ? { inscricao_municipal_prestador: imBruto } : {}),
    codigo_opcao_simples_nacional: opcao,
    ...(regSimples !== undefined ? { regime_tributario_simples_nacional: regSimples } : {}),
    regime_especial_tributacao: regEspecial,
    [docTipo === 'cpf' ? 'cpf_tomador' : 'cnpj_tomador']: documento,
    razao_social_tomador: nome,
    ...(email ? { email_tomador: email } : {}),
    ...(telefone ? { telefone_tomador: telefone } : {}),
    ...(end
      ? {
          ...(end.cep ? { cep_tomador: end.cep } : {}),
          ...(end.codigoMunicipioIbge ? { codigo_municipio_tomador: Number(end.codigoMunicipioIbge) } : {}),
          ...(end.logradouro ? { logradouro_tomador: end.logradouro } : {}),
          ...(end.numero ? { numero_tomador: end.numero } : {}),
          ...(end.bairro ? { bairro_tomador: end.bairro } : {}),
          ...(end.complemento ? { complemento_tomador: end.complemento } : {}),
        }
      : {}),
    codigo_municipio_prestacao: conta.municipio,
    codigo_tributacao_nacional_iss: codigoTrib,
    ...(tribMunicipal ? { codigo_tributacao_municipal_iss: tribMunicipal } : {}),
    descricao_servico: descricao,
    ...(nbs ? { codigo_nbs: nbs } : {}),
    ...(informacoes ? { informacoes_complementares: informacoes } : {}),
    valor_servico: valorCentavos / 100,
    tributacao_iss: tributacao,
    tipo_retencao_iss: retencao,
    ...(typeof aliq === 'number' ? { percentual_aliquota_relativa_municipio: aliq } : {}),
    finalidade_emissao: 0,
    consumidor_final: f.consumidorFinal ? 1 : 0,
    indicador_destinatario: indDest,
    ibs_cbs_situacao_tributaria: cst,
    ibs_cbs_classificacao_tributaria: cClass,
    ...(naoInformar ? { indicador_total_tributacao: 0 } : { percentual_total_tributos_simples_nacional: pTot }),
  };

  const resumo = {
    acao: 'EMITIR nota fiscal de serviço — NFS-e NACIONAL (Focus NFe)',
    ambiente: conta.ambiente === 'producao' ? 'PRODUÇÃO — NOTA REAL, COM VALIDADE FISCAL' : 'HOMOLOGAÇÃO — TESTE, SEM VALIDADE FISCAL',
    prestador: { clinica: conta.nome, cnpj: conta.cnpj, ...(perfil ? { razaoSocial: perfil.razaoSocial } : {}), municipio: `${perfil?.municipioNome ?? conta.municipio} (IBGE ${conta.municipio})`, ...(imBruto ? { inscricaoMunicipal: imBruto } : {}) },
    tomador: {
      nome,
      documento: mascararDoc(documento),
      ...(email ? { email: mascararEmail(email) } : {}),
      endereco: end ? 'informado' : 'não informado',
    },
    servico: {
      codigoDeTributacaoNacional: { valor: codigoTrib, origem: f.codigoTributacaoNacional?.trim() ? DE_QUEM_PEDIU : DO_PERFIL },
      ...(nbs ? { nbs: { valor: nbs, origem: f.codigoNbs?.trim() ? DE_QUEM_PEDIU : DO_PERFIL } } : {}),
      descricao: { texto: descricao, origem: a.descricao?.trim() ? DE_QUEM_PEDIU : DO_PERFIL },
      ...(informacoes ? { informacoesComplementares: informacoes } : {}),
    },
    valorDaNota: dinheiro(valorCentavos / 100),
    dataDeCompetencia: competencia,
    dataDeEmissao: 'o momento da confirmação',
    iss: {
      tributacao: 'operação tributável',
      retencao: NOMES_DA_RETENCAO[retencao!],
      aliquota: aliq === 'parametrizada' ? 'PARAMETRIZADA: não enviada; o ambiente nacional define a alíquota' : pct(aliq!),
      origem: f.aliquotaIss !== undefined ? DE_QUEM_PEDIU : (perfil?.aliquotaOrigem ?? DO_PERFIL),
    },
    simplesNacional: {
      opcao: `${opcao} — ${NOMES_DA_OPCAO_SIMPLES[opcao!]}`,
      origem: opcaoDada ? DE_QUEM_PEDIU : DO_PERFIL,
      ...(regSimples !== undefined ? { regimeDeApuracao: `${regSimples} — ${NOMES_DO_REGIME_SIMPLES[regSimples]}` } : {}),
    },
    regimeEspecialDeTributacao: `${regEspecial} — ${NOMES_DO_REGIME_ESPECIAL[regEspecial!]}`,
    totalAproximadoDeTributos: naoInformar ? 'NÃO informado (opção da contabilidade)' : `${pct(pTot!)} (alíquota do Simples, Lei 12.741)`,
    reformaTributaria: { cst, cClassTrib: cClass, consumidorFinal: SIM_NAO(f.consumidorFinal === true), indicadorDoDestinatario: '0 — o destinatário é o próprio tomador', finalidade: '0 — NFS-e regular' },
    dps: { serie: conta.serieDps ?? 1, numero: 'reservado na confirmação' },
    ...(origem ? { origem } : {}),
  };
  return {
    nota: { corpo, valorCentavos, dataCompetencia: competencia, tomadorMascarado: mascararDoc(documento), tomadorDocumento: documento, origem },
    resumo,
    avisos,
  };
}

function textoLimpoNome(bruto: string): string {
  const t = bruto.replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 150) throw new ErroDeEntrada('tomador.nome: de 3 a 150 caracteres');
  if (temDadoPessoal(t) || /@/.test(t)) throw new ErroDeEntrada('tomador.nome: não pode ter número de documento, telefone nem e-mail');
  return t;
}

function emailValido(bruto: string): string {
  const e = bruto.trim();
  if (e.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ErroDeEntrada('tomador.email: e-mail inválido (até 80 caracteres)');
  return e;
}

function telefoneValido(bruto: string): string {
  const d = digitos(bruto);
  if (d.length < 6 || d.length > 20) throw new ErroDeEntrada('tomador.telefone: de 6 a 20 dígitos');
  return d;
}

function enderecoValido(e: NonNullable<TomadorPedido['endereco']>) {
  const cep = e.cep?.trim() ? digitos(e.cep) : undefined;
  if (cep !== undefined && cep.length !== 8) throw new ErroDeEntrada('tomador.endereco.cep: 8 dígitos');
  const ibge = e.codigoMunicipioIbge?.trim() ? digitos(e.codigoMunicipioIbge) : undefined;
  if (ibge !== undefined && ibge.length !== 7) throw new ErroDeEntrada('tomador.endereco.codigoMunicipioIbge: 7 dígitos (código IBGE do município)');
  const curto = (v: string | undefined, campo: string, max: number) => {
    const t = v?.replace(/\s+/g, ' ').trim();
    if (t && t.length > max) throw new ErroDeEntrada(`tomador.endereco.${campo}: até ${max} caracteres`);
    return t || undefined;
  };
  return { cep, codigoMunicipioIbge: ibge, logradouro: curto(e.logradouro, 'logradouro', 255), numero: curto(e.numero, 'numero', 60), bairro: curto(e.bairro, 'bairro', 60), complemento: curto(e.complemento, 'complemento', 156) };
}

// ----------------------------------------------------------------- limites e trava de nota repetida

export function conferirLimites(esc: Pick<EstadoEscritaFocus, 'limites'>, livro: LivroDeNotas, repetida: NotaGuardada | null, valorCentavos: number, agora: number): void {
  if (repetida) {
    throw new ErroDeEntrada(
      `NOTA REPETIDA: já existe nota ativa para este tomador, valor, competência e origem (referência ${repetida.referencia}, ${repetida.status}${repetida.numeroNfse ? `, nº ${repetida.numeroNfse}` : ''}). Não emiti outra. Se for uma SEGUNDA nota de propósito, informe uma "origem" diferente (ex. o id da venda). Nada foi emitido.`,
    );
  }
  const valor = valorCentavos / 100;
  const lim = esc.limites;
  if (lim.porHora() <= 0) throw new ErroDeEntrada('a emissão de nota pelo conector está DESLIGADA: configure FOCUS_NFE_NOTAS_POR_HORA com o limite por hora (maior que 0)');
  const naHora = livro.naHora(agora, LIMITES_FOCUS.horaMs);
  if (naHora >= lim.porHora()) throw new ErroDeEntrada(`limite de ${lim.porHora()} notas por hora nesta unidade já foi atingido (${naHora}); tente mais tarde ou emita pelo painel da Focus`);
  if (valor > lim.tetoNota()) throw new ErroDeEntrada(`o valor ${dinheiro(valor)} passa do teto por nota (${dinheiro(lim.tetoNota())}). Só o João sobe o teto, no servidor (FOCUS_NFE_TETO_NOTA_REAIS). Nada foi emitido.`);
  const usado = livro.somaDoDia(agora);
  if (arredondar(usado + valor) > lim.tetoDia()) {
    throw new ErroDeEntrada(`passaria do teto do dia desta unidade (${dinheiro(lim.tetoDia())}; já usado hoje ${dinheiro(usado)}; esta nota ${dinheiro(valor)}). Só o João sobe o teto, no servidor (FOCUS_NFE_TETO_DIA_REAIS). Nada foi emitido.`);
  }
}

/** O portão: a unidade está em FOCUS_NFE_UNIDADES e a conta tem token. Falha fechada. */
export function contaDeNota(ctx: ContextoFocus, esc: Pick<EstadoEscritaFocus, 'unidades'>, unidade: string | undefined): ContaFocus {
  const c = resolverContaFocus(ctx, unidade);
  if (!esc.unidades().has(c.slug)) {
    throw new ErroDeEntrada(`a emissão de nota pela Focus NFe NÃO está ligada na unidade ${c.slug} (FOCUS_NFE_UNIDADES, no servidor; só o João liga). Nada foi feito.`);
  }
  return c;
}

async function umaPorVez<T>(esc: EstadoEscritaFocus, unidade: string, fn: () => Promise<T>): Promise<T> {
  const anterior = esc.filas.get(unidade) ?? Promise.resolve();
  const minha = anterior.catch(() => undefined).then(fn);
  const cauda = minha.catch(() => undefined);
  esc.filas.set(unidade, cauda);
  try {
    return await minha;
  } finally {
    if (esc.filas.get(unidade) === cauda) esc.filas.delete(unidade);
  }
}

const melhorEsforco = async <T>(fn: () => Promise<T>, ms: number): Promise<T | null> => {
  try {
    return await Promise.race([fn(), new Promise<null>((r) => setTimeout(() => r(null), ms).unref())]);
  } catch {
    return null;
  }
};

// ----------------------------------------------------------------- preparar

export async function prepararNota(ctx: ContextoFocus, esc: EstadoEscritaFocus, quem: QuemFocus, a: PedidoDePreparo) {
  const c = contaDeNota(ctx, esc, a.unidade);
  return a.acao === 'cancelar' ? prepararCancelamento(ctx, esc, c, quem, a) : prepararEmissao(ctx, esc, c, quem, a);
}

async function prepararEmissao(ctx: ContextoFocus, esc: EstadoEscritaFocus, c: ContaFocus, quem: QuemFocus, a: PedidoDePreparo) {
  const estranhos = (['referencia', 'justificativa'] as const).filter((k) => a[k] !== undefined && a[k] !== '');
  if (estranhos.length) throw new ErroDeEntrada(`${estranhos.join(', ')} é só para cancelar; para emitir informe o tomador, o valor e os dados fiscais`);
  const agora = esc.agora();
  const hoje = diaLocal(agora);
  const v = validarEmissao(c, a, hoje);
  const avisos: string[] = [avisoDoAmbiente(c.ambiente), ...v.avisos];
  // o cadastro público do CNPJ (via Focus): situação e Simples. Melhor esforço, mas um cadastro que CONTRADIZ o pedido recusa.
  const cadastro = await melhorEsforco(() => c.fonte.cnpj(c.cnpj!), 6000);
  if (!cadastro) avisos.push('não consegui conferir o cadastro público do CNPJ agora (situação e Simples Nacional): confira com focus_dados_fiscais');
  else {
    if (cadastro.situacao && cadastro.situacao.toLowerCase() !== 'ativa') throw new ErroDeEntrada(`o cadastro público do CNPJ do prestador está "${cadastro.situacao}": não dá para emitir. Nada foi preparado.`);
    const opcao = v.nota.corpo.codigo_opcao_simples_nacional as number;
    if (cadastro.optanteSimples === true && cadastro.optanteMei === false && opcao !== 3) {
      throw new ErroDeEntrada(`o cadastro público diz que o prestador é optante do Simples Nacional (não MEI), mas o pedido diz opção ${opcao} (${NOMES_DA_OPCAO_SIMPLES[opcao]}). Confirme com a contabilidade. Nada foi preparado.`);
    }
    if (cadastro.optanteSimples === false && opcao !== 1) throw new ErroDeEntrada(`o cadastro público diz que o prestador NÃO é optante do Simples Nacional, mas o pedido diz opção ${opcao}. Confirme com a contabilidade. Nada foi preparado.`);
    if (cadastro.codigoIbge && cadastro.codigoIbge !== c.municipio) avisos.push(`o município do cadastro público do CNPJ (IBGE ${cadastro.codigoIbge}) é diferente do configurado (${c.municipio}): confira antes de aprovar`);
  }
  // produção: o número da DPS precisa ser conhecido (lido da Focus ou escolhido) JÁ no resumo, para ninguém aprovar o que vai ser recusado com o código gasto
  if (c.ambiente === 'producao' && !c.numeroInicialExplicito) {
    const empresa = await melhorEsforco(() => c.fonte.empresa(c.cnpj!), 6000);
    if (numeroMinimoDaFocus(c, empresa) === undefined) throw new ErroDeEntrada(`${SEM_NUMERO_DA_DPS} Nada foi preparado.`);
  }
  // os limites e a nota repetida JÁ no resumo (sem reservar): ninguém aprova um resumo que vai falhar no confirmar com o código gasto. O confirmar reserva de verdade.
  const chave = chaveDeNotaRepetida(c.slug, c.ambiente, v.nota.tomadorDocumento, v.nota.valorCentavos, v.nota.dataCompetencia, v.nota.origem);
  const [livro, repetida] = await Promise.all([ctx.notas.ler(c.slug, c.ambiente, agora), ctx.notas.ativaPorChave(c.slug, c.ambiente, chave)]);
  try {
    conferirLimites(esc, livro, repetida, v.nota.valorCentavos, agora);
  } catch (e) {
    if (e instanceof ErroDeEntrada) throw new ErroDeEntrada(`${e.message.replace(/ Nada foi emitido\.$/, '')} Nada foi preparado.`);
    throw e;
  }
  const { codigo, expiraEm } = esc.pendentes.guardar({ acao: 'emitir', usuario: quem.id, unidade: c.slug, ambiente: c.ambiente, nota: v.nota, resumo: v.resumo });
  return {
    unidade: c.slug,
    ambiente: rotuloDoAmbiente(c.ambiente),
    acao: 'emitir',
    resumo: v.resumo,
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `NADA foi emitido nem gravado na Focus ainda. Este é o ambiente de ${rotuloDoAmbiente(c.ambiente)}. Mostre o resumo COMPLETO e os avisos à pessoa e, só se ela aprovar, chame focus_confirmar_nota com confirmacao="${codigo}" (vale 15 minutos, uma vez, só para você).`,
  };
}

const CANCELAVEL = 'autorizado';

async function prepararCancelamento(ctx: ContextoFocus, esc: EstadoEscritaFocus, c: ContaFocus, quem: QuemFocus, a: PedidoDePreparo) {
  // valor neutro (vazio, false, objeto vazio) é o que o modelo manda "por padrão": não é pedido de emissão e não derruba o cancelamento
  const neutro = (v: unknown) => v === undefined || v === null || v === '' || v === false || (typeof v === 'object' && Object.keys(v as object).length === 0);
  const extras = (['tomador', 'valor', 'descricao', 'dataCompetencia', 'origem', 'fiscal'] as const).filter((k) => !neutro(a[k]));
  if (extras.length) throw new ErroDeEntrada(`para cancelar informe só a referência e a justificativa; estes campos são de emissão e não valem aqui: ${extras.join(', ')}`);
  if (!a.referencia?.trim()) throw new ErroDeEntrada('informe a referencia da nota a cancelar (veja em focus_notas)');
  if (!a.justificativa?.trim()) throw new ErroDeEntrada('informe a justificativa do cancelamento (15 a 255 caracteres): vai para o ambiente nacional');
  const justificativa = textoLimpo(a.justificativa, 'justificativa', 15, 255);
  const ref = a.referencia.trim();
  const local = await ctx.notas.porReferencia(c.slug, c.ambiente, ref);
  if (!local) throw new ErroDeEntrada(`não há nota com a referência ${ref} no livro do conector (${rotuloDoAmbiente(c.ambiente)}): só cancelo o que este conector emitiu. Nada foi preparado.`);
  // o status de agora, direto da Focus (o livro pode estar atrasado)
  const { nota } = await sincronizarNota(ctx, c, local);
  if (nota.status !== CANCELAVEL) {
    throw new ErroDeEntrada(`a nota ${ref} está com o status "${nota.status}": só nota AUTORIZADA se cancela${nota.status === 'processando_autorizacao' ? ' (espere o ambiente nacional autorizar; veja com focus_nota)' : nota.status === 'cancelado' ? ' (ela já está cancelada)' : ''}. Nada foi preparado.`);
  }
  const avisos = [avisoDoAmbiente(c.ambiente), 'o cancelamento é DEFINITIVO e não pode ser desfeito; o ambiente nacional pode NEGAR (prazo, regras do município) e então a nota continua valendo'];
  const resumo = {
    acao: 'CANCELAR nota fiscal de serviço — NFS-e NACIONAL (Focus NFe)',
    ambiente: c.ambiente === 'producao' ? 'PRODUÇÃO — NOTA REAL, COM VALIDADE FISCAL' : 'HOMOLOGAÇÃO — TESTE, SEM VALIDADE FISCAL',
    clinica: c.nome,
    nota: mostrarNota(nota),
    justificativa,
  };
  const { codigo, expiraEm } = esc.pendentes.guardar({ acao: 'cancelar', usuario: quem.id, unidade: c.slug, ambiente: c.ambiente, referencia: ref, justificativa, statusAntes: nota.status, valorCentavos: nota.valorCentavos, resumo });
  return {
    unidade: c.slug,
    ambiente: rotuloDoAmbiente(c.ambiente),
    acao: 'cancelar',
    resumo,
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `NADA foi cancelado ainda. Este é o ambiente de ${rotuloDoAmbiente(c.ambiente)}. Mostre o resumo e os avisos à pessoa e, só se ela aprovar, chame focus_confirmar_nota com confirmacao="${codigo}" (vale 15 minutos, uma vez, só para você).`,
  };
}

// ----------------------------------------------------------------- confirmar

const quemTexto = (q: QuemFocus) => `${q.email ? `${q.email} ` : ''}(usuário ${q.id})`;

function aviso(titulo: string, c: ContaFocus, q: QuemFocus, extra: { valorCentavos?: number; referencia?: string; detalhe?: string }): string {
  return [
    `Focus NFe · ${titulo} (${rotuloDoAmbiente(c.ambiente)})`,
    `Unidade: ${c.slug} (${c.nome})`,
    ...(extra.valorCentavos !== undefined ? [`Valor: ${dinheiro(extra.valorCentavos / 100)}`] : []),
    `Quem pediu: ${quemTexto(q)}`,
    ...(extra.referencia ? [`Referência: ${extra.referencia}`] : []),
    ...(extra.detalhe ? [extra.detalhe] : []),
  ].join('\n');
}

export interface RespostaDeEmissao {
  unidade: string;
  ambiente: string;
  avisoDoAmbiente: string;
  emissaoPedida: true;
  nota: ReturnType<typeof mostrarNota>;
  aviso: string;
  registro: string;
  consumoDoDia: unknown;
}

export interface RespostaDeCancelamento {
  unidade: string;
  ambiente: string;
  cancelada: boolean;
  cancelamentoNegado?: true;
  motivo?: string;
  nota: ReturnType<typeof mostrarNota>;
  aviso?: string;
  registro?: string;
}

export async function confirmarNota(ctx: ContextoFocus, esc: EstadoEscritaFocus, quem: QuemFocus, a: { confirmacao: string }): Promise<RespostaDeEmissao | RespostaDeCancelamento> {
  const p = esc.pendentes.tirar(a.confirmacao, quem.id);
  // a conta de novo: se a emissão foi desligada (ou a unidade saiu do conector) desde o resumo, nada é gravado; o código JÁ foi gasto e a mensagem diz
  let c: ContaFocus;
  try {
    c = contaDeNota(ctx, esc, p.unidade);
  } catch (e) {
    throw new ErroDeEntrada(`${e instanceof Error ? e.message : 'a unidade não está disponível'} O código foi gasto: prepare de novo quando a unidade voltar.`);
  }
  if (c.ambiente !== p.ambiente) {
    throw new ErroDeEntrada(`o ambiente da unidade mudou desde o resumo (era ${rotuloDoAmbiente(p.ambiente)}, agora é ${rotuloDoAmbiente(c.ambiente)}): não fiz nada. Prepare de novo. O código foi gasto.`);
  }
  if (p.acao === 'emitir') return emitirNotaConfirmada(ctx, esc, c, quem, p.nota, `ddnf${a.confirmacao.trim().toLowerCase()}`);
  return cancelarNotaConfirmada(ctx, esc, c, quem, p);
}

/**
 * EMITE uma nota JÁ validada (o ponto de encaixe da emissão automática: ver o cabeçalho do arquivo). Reserva (limites, nota repetida, número da DPS) → POST → confere → avisa.
 * `referencia`: só letras e números, única na unidade e no ambiente.
 */
export async function emitirNotaConfirmada(ctx: ContextoFocus, esc: EstadoEscritaFocus, c: ContaFocus, quem: QuemFocus, nota: NotaValidada, referencia: string): Promise<RespostaDeEmissao> {
  // o portão do perfil vale para QUALQUER chamador (o manual e o automático futuro), não só para a validação do pedido
  if (c.conflitoDePerfil) throw new ErroDeEntrada(`${c.conflitoDePerfil} Nada foi emitido.`);
  const agora = esc.agora();
  const hoje = diaLocal(agora);
  if (nota.dataCompetencia > hoje) throw new ErroDeEntrada(`a competência aprovada (${nota.dataCompetencia}) é futura (hoje é ${hoje}): não emiti. Prepare de novo. Nada foi emitido.`);
  const serie = c.serieDps ?? 1;
  if (c.ambiente === 'producao' && c.serieDps === undefined) throw new ErroDeEntrada('produção sem a série da DPS configurada: não emiti. Nada foi emitido.');
  const chave = chaveDeNotaRepetida(c.slug, c.ambiente, nota.tomadorDocumento, nota.valorCentavos, nota.dataCompetencia, nota.origem);
  const criadoPor = quem.email || `usuario:${quem.id}`;
  return umaPorVez(esc, c.slug, async () => {
    // o número da DPS nunca fica abaixo do que a Focus já guarda para a série (a empresa dela tem `proximo_numero_nfsen_*`); DPS repetida é recusada pelo ambiente nacional
    const empresa = await melhorEsforco(() => c.fonte.empresa(c.cnpj!), 6000);
    const numeroMinimo = numeroMinimoDaFocus(c, empresa);
    // produção sem saber o próximo número da Focus e sem número de partida escolhido: nada de adivinhar
    if (c.ambiente === 'producao' && numeroMinimo === undefined && !c.numeroInicialExplicito) {
      throw new ErroDeEntrada(`${SEM_NUMERO_DA_DPS} Nada foi emitido. O código foi gasto: prepare de novo.`);
    }
    // a reserva que vale: dentro da trava da unidade, relê o banco, confere tudo e grava a INTENÇÃO antes de qualquer chamada à Focus
    const { serieDps, numeroDps } = await ctx.notas.reservar({
      unidade: c.slug, ambiente: c.ambiente, referencia, chaveDuplicata: chave, valorCentavos: nota.valorCentavos, dataCompetencia: nota.dataCompetencia, tomadorMascarado: nota.tomadorMascarado,
      origem: nota.origem, criadoPor, agora, serieDps: serie, numeroInicial: c.numeroInicial, ...(numeroMinimo !== undefined ? { numeroMinimo } : {}),
      conferir: (livro, repetida) => conferirLimites(esc, livro, repetida, nota.valorCentavos, agora),
    });
    // 60 s para trás: o ambiente nacional recusa data de emissão no futuro e o relógio dele pode estar um pouco atrás do nosso
    const emissao = `${new Date(esc.agora() - 60_000 - 3 * 3_600_000).toISOString().slice(0, 19)}-03:00`;
    const corpo = { ...nota.corpo, data_emissao: emissao, serie_dps: serieDps, numero_dps: numeroDps };
    try {
      await c.fonte.emitir(referencia, corpo);
    } catch (e) {
      const status = e instanceof ErroFocus ? e.status : null;
      const msg = e instanceof Error ? e.message : String(e);
      const recusa = status !== null && RECUSA_CERTA.has(status);
      if (recusa) {
        await ctx.notas.atualizar(c.slug, c.ambiente, referencia, { status: 'recusada', ultimoEvento: 'recusada_pela_focus', erro: mascararErro(msg).slice(0, 400) }).catch(() => undefined);
        void esc.alertar(aviso('NOTA RECUSADA PELA FOCUS', c, quem, { valorCentavos: nota.valorCentavos, referencia, detalhe: mascararErro(msg).slice(0, 300) })).catch(() => false);
        throw new ErroDeEntrada(`${msg}. Nada foi emitido (o código foi gasto: ajuste o pedido e prepare de novo).`);
      }
      // sem resposta clara (timeout, 5xx, formato): a nota PODE existir. A referência é nossa: a consulta diz.
      const achada = await melhorEsforco(() => c.fonte.consultar(referencia), 8000);
      if (!achada) {
        await ctx.notas.atualizar(c.slug, c.ambiente, referencia, { status: 'incerto', ultimoEvento: 'emissao_sem_resposta', erro: mascararErro(msg).slice(0, 400) }).catch(() => undefined);
        void esc.alertar(aviso('NOTA FISCAL COM RESULTADO INCERTO', c, quem, { valorCentavos: nota.valorCentavos, referencia, detalhe: 'A Focus não confirmou a emissão: a nota PODE ter sido emitida. Conferir no painel da Focus antes de repetir.' })).catch(() => false);
        throw new ErroDeEntrada(`${msg} — a nota PODE ter sido emitida (referência ${referencia}): confira com focus_nota antes de repetir. NÃO emita de novo.`);
      }
      // a consulta achou a referência: a Focus tem a nota (o status de verdade vem da sincronização logo abaixo)
    }
    // a Focus JÁ tem a nota: daqui para a frente falha de banco nunca pode virar "nada foi emitido" (a pessoa tentaria de novo e emitiria a segunda nota real)
    let atual: NotaGuardada;
    try {
      // sempre `processando_autorizacao`: quem promove a autorizada é a consulta (ela traz o número e os links)
      await ctx.notas.atualizar(c.slug, c.ambiente, referencia, { status: 'processando_autorizacao', ultimoEvento: 'emissao_aceita' });
      atual = (await ctx.notas.porReferencia(c.slug, c.ambiente, referencia)) ?? (() => { throw new Error('nota sumiu do livro'); })();
    } catch {
      void esc.alertar(aviso('NOTA PEDIDA, GRAVAÇÃO LOCAL FALHOU', c, quem, { valorCentavos: nota.valorCentavos, referencia, detalhe: `A Focus ACEITOU a nota (DPS ${serieDps}/${numeroDps}), mas o banco não registrou o status. Conferir com focus_nota.` })).catch(() => false);
      throw new ErroDeEntrada(`a nota FOI pedida à Focus (referência ${referencia}), mas não consegui gravar o status no banco: confira com focus_nota. NÃO emita de novo.`);
    }
    // uma consulta logo depois: a autorização costuma levar segundos e, se já veio, a resposta já traz o número e os links
    const sync = await melhorEsforco(() => sincronizarNota(ctx, c, atual), 6000);
    if (sync) atual = sync.nota;
    void esc.alertar(aviso(atual.status === 'autorizado' ? 'NOTA FISCAL EMITIDA' : 'NOTA FISCAL: EMISSÃO PEDIDA', c, quem, { valorCentavos: nota.valorCentavos, referencia, detalhe: `DPS ${serieDps}/${numeroDps} · status: ${atual.status}${nota.origem ? ` · origem ${nota.origem}` : ''}` })).catch(() => false);
    const consumo = await consumoDoDiaFocus(ctx, esc.limites, c).catch(() => ({ indisponivel: 'não consegui ler os limites agora; a nota JÁ foi pedida.' }));
    return {
      unidade: c.slug,
      ambiente: rotuloDoAmbiente(c.ambiente),
      avisoDoAmbiente: avisoDoAmbiente(c.ambiente),
      emissaoPedida: true as const,
      nota: mostrarNota(atual, true),
      aviso:
        atual.status === 'autorizado'
          ? 'Nota autorizada.'
          : 'Quem autoriza a nota é o ambiente nacional, e isso leva um tempo: confira o status e os links do PDF/XML com focus_nota.',
      registro: 'Registrado com quem pediu e quem aprovou o resumo.',
      consumoDoDia: consumo,
    };
  });
}

async function cancelarNotaConfirmada(ctx: ContextoFocus, esc: EstadoEscritaFocus, c: ContaFocus, quem: QuemFocus, p: Extract<PedidoGuardado, { acao: 'cancelar' }>): Promise<RespostaDeCancelamento> {
  const local = await ctx.notas.porReferencia(c.slug, c.ambiente, p.referencia);
  if (!local) throw new ErroDeEntrada(`a nota ${p.referencia} não está mais no livro do conector: não cancelei. Prepare de novo. Nada foi feito.`);
  const { nota: antes } = await sincronizarNota(ctx, c, local);
  if (antes.status !== p.statusAntes) {
    throw new ErroDeEntrada(`a nota ${p.referencia} mudou de status desde o resumo (era "${p.statusAntes}", agora é "${antes.status}"): não cancelei. Prepare de novo. Nada foi feito.`);
  }
  return umaPorVez(esc, c.slug, async () => {
    // a intenção fica marcada ANTES de chamar a Focus
    await ctx.notas.atualizar(c.slug, c.ambiente, p.referencia, { ultimoEvento: 'cancelamento_pedido' });
    let r: { status: string; erros?: Array<{ codigo?: string; mensagem?: string }> } | null = null;
    try {
      r = await c.fonte.cancelar(p.referencia, p.justificativa);
    } catch (e) {
      const status = e instanceof ErroFocus ? e.status : null;
      const msg = e instanceof Error ? e.message : String(e);
      if (status !== null && RECUSA_CERTA.has(status)) {
        void esc.alertar(aviso('CANCELAMENTO RECUSADO PELA FOCUS', c, quem, { valorCentavos: p.valorCentavos, referencia: p.referencia, detalhe: mascararErro(msg).slice(0, 300) })).catch(() => false);
        throw new ErroDeEntrada(`${msg}. Nada foi cancelado (o código foi gasto: prepare de novo se quiser tentar outra vez).`);
      }
      // sem resposta: a consulta diz se o pedido chegou
      const lida = await melhorEsforco(() => c.fonte.consultar(p.referencia), 8000);
      if (lida?.status === 'cancelado') r = { status: 'cancelado' };
      else {
        void esc.alertar(aviso('CANCELAMENTO DE NOTA COM RESULTADO INCERTO', c, quem, { valorCentavos: p.valorCentavos, referencia: p.referencia, detalhe: 'A Focus não confirmou: o cancelamento PODE ter sido pedido. Conferir no painel da Focus.' })).catch(() => false);
        throw new ErroDeEntrada(`${msg} — o cancelamento PODE ter sido pedido: confira com focus_nota antes de repetir.`);
      }
    }
    if (r.status === 'cancelado') {
      await ctx.notas.atualizar(c.slug, c.ambiente, p.referencia, { status: 'cancelado', canceladaEm: new Date(esc.agora()), ultimoEvento: 'cancelada' });
      void esc.alertar(aviso('NOTA FISCAL: CANCELADA', c, quem, { valorCentavos: p.valorCentavos, referencia: p.referencia })).catch(() => false);
      return { unidade: c.slug, ambiente: rotuloDoAmbiente(c.ambiente), cancelada: true as const, nota: mostrarNota((await ctx.notas.porReferencia(c.slug, c.ambiente, p.referencia))!), registro: 'Registrado com quem pediu e quem aprovou o resumo.' };
    }
    // erro_cancelamento: a nota CONTINUA valendo; fica marcada para revisão
    const motivo = mascararErro((r.erros ?? []).slice(0, 3).map((x) => [x.codigo, x.mensagem].filter(Boolean).join(' ')).join(' | ')).slice(0, 400) || 'sem detalhe';
    await ctx.notas.atualizar(c.slug, c.ambiente, p.referencia, { revisao: `cancelamento NEGADO pela Focus/prefeitura: ${motivo}`, ultimoEvento: 'cancelamento_negado', erro: motivo });
    void esc.alertar(aviso('CANCELAMENTO NEGADO', c, quem, { valorCentavos: p.valorCentavos, referencia: p.referencia, detalhe: motivo })).catch(() => false);
    return {
      unidade: c.slug,
      ambiente: rotuloDoAmbiente(c.ambiente),
      cancelada: false,
      cancelamentoNegado: true as const,
      motivo,
      nota: mostrarNota((await ctx.notas.porReferencia(c.slug, c.ambiente, p.referencia))!),
      aviso: 'A nota CONTINUA VALENDO. Se for preciso cancelar mesmo assim, o caminho é o portal da prefeitura/Portal Nacional, com a contabilidade.',
    };
  });
}

// ----------------------------------------------------------------- registro

/** A auditoria guarda os argumentos como vieram: CPF, nome, e-mail, telefone e endereço do paciente NUNCA entram nela. */
export function limparArgumentos(a: unknown): unknown {
  if (!a || typeof a !== 'object') return a;
  const o = { ...(a as Record<string, unknown>) };
  const t = o.tomador;
  if (t && typeof t === 'object') {
    const x = t as Record<string, unknown>;
    const doc = typeof x.cpf === 'string' ? x.cpf : typeof x.cnpj === 'string' ? x.cnpj : '';
    o.tomador = { documento: doc ? mascararDoc(doc) : null, nome: x.nome ? '[removido]' : null, email: x.email ? '[removido]' : null, telefone: x.telefone ? '[removido]' : null, endereco: x.endereco ? '[removido]' : null };
  }
  for (const k of ['descricao', 'origem', 'justificativa'] as const) {
    const v = o[k];
    if (typeof v === 'string' && (temDadoPessoal(v) || /@/.test(v))) o[k] = '[removido: continha número longo ou e-mail]';
  }
  const f = o.fiscal;
  if (f && typeof f === 'object') {
    const x = { ...(f as Record<string, unknown>) };
    if (typeof x.informacoesComplementares === 'string' && (temDadoPessoal(x.informacoesComplementares) || /@/.test(x.informacoesComplementares))) x.informacoesComplementares = '[removido: continha número longo ou e-mail]';
    o.fiscal = x;
  }
  return o;
}

export function auditarSemDadoDoPaciente(auditar: Auditar): Auditar {
  return (r) => auditar({ ...r, argumentos: limparArgumentos(r.argumentos) });
}

const tomadorSchema = z
  .object({
    cpf: z.string().max(20).optional().describe('CPF do tomador (paciente), com ou sem pontuação; ou informe o cnpj'),
    cnpj: z.string().max(20).optional(),
    nome: z.string().max(150).optional().describe('nome (ou razão social) do tomador'),
    email: z.string().max(80).optional(),
    telefone: z.string().max(20).optional(),
    endereco: z
      .object({
        cep: z.string().max(12).optional(),
        codigoMunicipioIbge: z.string().max(10).optional().describe('código IBGE de 7 dígitos do município do tomador'),
        logradouro: z.string().max(255).optional(),
        numero: z.string().max(60).optional(),
        bairro: z.string().max(60).optional(),
        complemento: z.string().max(156).optional(),
      })
      .optional(),
  })
  .optional();

const fiscalSchema = z
  .object({
    codigoTributacaoNacional: z.string().max(10).optional().describe('cTribNac, 6 dígitos (a unidade pode ter um padrão da contabilidade)'),
    codigoTributacaoMunicipal: z.string().max(3).optional(),
    codigoNbs: z.string().max(15).optional().describe('NBS, 9 dígitos (a unidade pode ter um padrão)'),
    inscricaoMunicipalPrestador: z.string().max(15).optional(),
    tributacaoIss: z.number().int().optional().describe('1 = operação tributável (a única suportada)'),
    tipoRetencaoIss: z.number().int().optional().describe('1 = ISS não retido; 2 = retido pelo tomador'),
    aliquotaIss: z.union([z.number().min(0).max(100), z.literal('parametrizada')]).optional().describe('alíquota do ISS em %, ou "parametrizada" (o ambiente nacional define). NUNCA suponha: pergunte à contabilidade'),
    opcaoSimplesNacional: z.number().int().optional().describe('1 não optante, 2 MEI, 3 ME/EPP (a unidade pode ter um padrão)'),
    regimeApuracaoSimples: z.number().int().optional().describe('1, 2 ou 3 (obrigatório para ME/EPP)'),
    regimeEspecialTributacao: z.number().int().optional().describe('0 nenhum, 1, 2, 3, 4, 5, 6 ou 9'),
    ibsCbs: z.object({ situacaoTributaria: z.string().max(5).optional().describe('CST do IBS/CBS, 3 dígitos'), classificacaoTributaria: z.string().max(8).optional().describe('cClassTrib, 6 dígitos') }).optional(),
    consumidorFinal: z.boolean().optional(),
    percentualTotalTributosSimples: z.number().min(0).max(100).optional().describe('total aproximado de tributos (alíquota do Simples) em %; ou use naoInformarTotalTributos'),
    naoInformarTotalTributos: z.boolean().optional().describe('true = não informar o total aproximado de tributos (escolha da contabilidade)'),
    indicadorDestinatario: z.number().int().optional().describe('0 = o destinatário é o próprio tomador'),
    informacoesComplementares: z.string().max(2000).optional(),
  })
  .optional();

export function registrarEscritaFocus(server: McpServer, ctx: ContextoFocus, esc: EstadoEscritaFocus, quem: QuemFocus, auditarBruto: Auditar): void {
  const auditar = auditarSemDadoDoPaciente(auditarBruto);
  server.registerTool(
    'focus_preparar_nota',
    {
      title: 'Preparar emissão ou cancelamento de nota fiscal (Focus NFe, NFS-e Nacional)',
      description:
        'PRIMEIRO PASSO para EMITIR ou CANCELAR uma NFS-e NACIONAL pela Focus NFe (use para o que NÃO passa pelo Asaas: InfinitePay, Pix direto, maquininha). NÃO emite nem cancela: confere tudo, ' +
        'mostra o resumo COMPLETO (o AMBIENTE vem em maiúsculas: HOMOLOGAÇÃO é teste sem valor fiscal, PRODUÇÃO é nota real) e devolve um código. Mostre o resumo inteiro e os avisos à pessoa e só chame focus_confirmar_nota se ela aprovar. ' +
        'Só nas unidades que o João ligou. NUNCA suponha alíquota do ISS, retenção, regime nem código de serviço: o que a pessoa não disse e o perfil da unidade não traz, o conector recusa e lista (pergunte à pessoa ou à contabilidade). ' +
        'acao "emitir": informe tomador (cpf ou cnpj, nome), valor, dataCompetencia (AAAA-MM-DD), origem (id da venda, sem dado pessoal; vale para nota repetida) e fiscal. acao "cancelar": informe referencia e justificativa (15 a 255 caracteres). ' +
        'Só para quem altera cartões.',
      inputSchema: {
        unidade: z.string().optional().describe('unidade com Focus NFe ligada (slug ou nome curto); opcional se só houver uma'),
        acao: z.enum(['emitir', 'cancelar']),
        tomador: tomadorSchema,
        valor: z.number().positive().max(1_000_000).optional().describe('valor da nota em reais, no máximo 2 casas'),
        descricao: z.string().max(1000).optional().describe('texto do serviço que sai na nota (a unidade pode ter um padrão); sem CPF, telefone nem e-mail'),
        dataCompetencia: z.string().optional().describe('data em que o serviço foi prestado, AAAA-MM-DD'),
        origem: z.string().max(60).optional().describe('de onde sai a nota (ex. id da venda na InfinitePay); sem dado pessoal. Duas notas iguais só passam com origens diferentes'),
        fiscal: fiscalSchema,
        referencia: z.string().max(50).optional().describe('cancelar: a referência da nota (veja em focus_notas)'),
        justificativa: z.string().max(255).optional().describe('cancelar: o motivo (15 a 255 caracteres), sem dado pessoal'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => executar('focus_preparar_nota', args, auditar, () => prepararNota(ctx, esc, quem, args as PedidoDePreparo)),
  );
  server.registerTool(
    'focus_confirmar_nota',
    {
      title: 'Confirmar emissão ou cancelamento de nota fiscal (Focus NFe)',
      description:
        'SEGUNDO PASSO: só depois de a pessoa ver o resumo completo de focus_preparar_nota e APROVAR. Emite (ou cancela) de verdade. O código vale 15 minutos, uma vez, e só para quem preparou. ' +
        'Em PRODUÇÃO a nota é REAL. A emissão é assíncrona: confira o resultado com focus_nota. Sem resposta clara da Focus o resultado fica INCERTO e a nota PODE existir: nunca repita sem conferir. O João é avisado no Telegram. Só para quem altera cartões.',
      inputSchema: { confirmacao: z.string().min(4).max(40).describe('o código devolvido por focus_preparar_nota') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) => executar('focus_confirmar_nota', args, auditar, () => confirmarNota(ctx, esc, quem, args)),
  );
}

/**
 * O portão testado: só vê as ferramentas quem escreve (a lista de escrita do conector) E só se FOCUS_NFE_UNIDADES tem alguma unidade. Fora disso elas nem existem na
 * sessão (e as funções recusam de novo ao chamar). Devolve se registrou.
 */
export function registrarFocusSePermitido(
  server: McpServer,
  ctx: ContextoFocus,
  esc: EstadoEscritaFocus,
  usuario: string,
  escritores: ReadonlySet<string>,
  auditar: Auditar,
  quem: { email?: string; clientId?: string } = {},
): boolean {
  if (!escritores.has(usuario)) return false;
  if (esc.unidades().size === 0) return false;
  const eles: QuemFocus = { id: usuario, ...(quem.email ? { email: quem.email } : {}), ...(quem.clientId ? { clientId: quem.clientId } : {}) };
  registrarLeituraFocus(server, ctx, esc.limites, auditarSemDadoDoPaciente(auditar));
  registrarEscritaFocus(server, ctx, esc, eles, auditar);
  return true;
}

