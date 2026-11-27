/** O armazém de notas da Focus em MEMÓRIA, com as mesmas regras do de produção (trava, nota repetida, número da DPS): só para teste. */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroFocus, type Ambiente, type CadastroPublico, type CancelamentoFocus, type EmissaoAceita, type EmpresaFocus, type GatilhoFocus, type NotaFocus } from '../lib/integracoes/focus-nfe.js';
import { LIMITES_FOCUS, LivroDeNotas, STATUS_ATIVOS, type ArmazemDeNotas, type ContaFocus, type NotaGuardada, type PatchDaNota, type PedidoDeReserva } from './focus-nfe.js';

export interface ArmazemEmMemoria extends ArmazemDeNotas {
  linhas: NotaGuardada[];
  /** faz a próxima chamada de `reservar` falhar como o banco fora do ar */
  falharBanco: boolean;
}

export function armazemDeNotasEmMemoria(agora: () => number = Date.now): ArmazemEmMemoria {
  const linhas: NotaGuardada[] = [];
  const livro = (unidade: string, ambiente: Ambiente, t: number) =>
    new LivroDeNotas(linhas.filter((l) => l.unidade === unidade && l.ambiente === ambiente && t - Date.parse(l.criadoEm) < LIMITES_FOCUS.janelaLivroMs).map((l) => ({ valorCentavos: l.valorCentavos, status: l.status, em: Date.parse(l.criadoEm) })));
  const m: ArmazemEmMemoria = {
    linhas,
    falharBanco: false,
    async listar(f) {
      return linhas
        .filter((l) => l.unidade === f.unidade && (!f.ambiente || l.ambiente === f.ambiente) && (!f.status || l.status === f.status) && (!f.de || Date.parse(l.criadoEm) >= f.de.getTime()) && (!f.ate || Date.parse(l.criadoEm) <= f.ate.getTime()))
        .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm))
        .slice(0, f.limite);
    },
    async porReferencia(u, a, r) {
      return linhas.find((l) => l.unidade === u && l.ambiente === a && l.referencia === r) ?? null;
    },
    async porReferenciaEmQualquerAmbiente(u, r) {
      return linhas.find((l) => l.unidade === u && l.referencia === r) ?? null;
    },
    async ativaPorChave(u, a, chave) {
      return linhas.find((l) => l.unidade === u && l.ambiente === a && l.chaveDuplicata === chave && STATUS_ATIVOS.includes(l.status)) ?? null;
    },
    async ler(u, a, t) {
      return livro(u, a, t);
    },
    async reservar(p: PedidoDeReserva) {
      if (m.falharBanco) throw new ErroDeEntrada('não consegui conferir nem registrar a nota no banco: nada foi emitido; tente em instantes');
      const repetida = linhas.find((l) => l.unidade === p.unidade && l.ambiente === p.ambiente && l.chaveDuplicata === p.chaveDuplicata && STATUS_ATIVOS.includes(l.status)) ?? null;
      p.conferir(livro(p.unidade, p.ambiente, p.agora), repetida);
      if (linhas.some((l) => l.unidade === p.unidade && l.ambiente === p.ambiente && l.referencia === p.referencia)) throw new ErroDeEntrada(`a referência ${p.referencia} já foi usada nesta unidade. Prepare de novo. Nada foi emitido.`);
      const ultimo = Math.max(0, ...linhas.filter((l) => l.unidade === p.unidade && l.ambiente === p.ambiente && l.serieDps === p.serieDps).map((l) => l.numeroDps));
      const numeroDps = Math.max(p.numeroInicial, ultimo + 1, p.numeroMinimo ?? 0);
      linhas.push({
        referencia: p.referencia, unidade: p.unidade, ambiente: p.ambiente, status: 'intencao', serieDps: p.serieDps, numeroDps, valorCentavos: p.valorCentavos, dataCompetencia: p.dataCompetencia,
        tomadorMascarado: p.tomadorMascarado, origem: p.origem, chaveDuplicata: p.chaveDuplicata, criadoPor: p.criadoPor, criadoEm: new Date(p.agora).toISOString(), numeroNfse: null, codigoVerificacao: null,
        urlConsulta: null, urlDanfse: null, caminhoXml: null, emitidaEm: null, canceladaEm: null, revisao: null, ultimoEvento: null, erro: null,
      });
      return { serieDps: p.serieDps, numeroDps };
    },
    async atualizar(u, a, r, patch: PatchDaNota) {
      const l = linhas.find((x) => x.unidade === u && x.ambiente === a && x.referencia === r);
      if (!l) return null;
      const set = <K extends keyof NotaGuardada>(k: K, v: NotaGuardada[K] | undefined) => {
        if (v !== undefined) l[k] = v;
      };
      set('status', patch.status);
      set('numeroNfse', patch.numeroNfse);
      set('codigoVerificacao', patch.codigoVerificacao);
      set('urlConsulta', patch.urlConsulta);
      set('urlDanfse', patch.urlDanfse);
      set('caminhoXml', patch.caminhoXml);
      set('emitidaEm', patch.emitidaEm === undefined ? undefined : patch.emitidaEm ? patch.emitidaEm.toISOString() : null);
      set('canceladaEm', patch.canceladaEm === undefined ? undefined : patch.canceladaEm ? patch.canceladaEm.toISOString() : null);
      set('revisao', patch.revisao);
      set('ultimoEvento', patch.ultimoEvento);
      set('erro', patch.erro);
      return l;
    },
  };
  void agora;
  return m;
}

// ----------------------------------------------------------------- a Focus de mentira (formato DOCUMENTADO)

/** Os campos que a documentação do DPS marca como obrigatórios e que este conector sempre manda (a Focus recusa de imediato com 400 se faltar). */
const OBRIGATORIOS_DO_DPS = [
  'data_emissao', 'serie_dps', 'numero_dps', 'data_competencia', 'emitente_dps', 'codigo_municipio_emissora', 'cnpj_prestador', 'codigo_opcao_simples_nacional', 'regime_especial_tributacao',
  'codigo_municipio_prestacao', 'codigo_tributacao_nacional_iss', 'descricao_servico', 'valor_servico', 'tributacao_iss', 'finalidade_emissao', 'consumidor_final', 'indicador_destinatario',
  'ibs_cbs_situacao_tributaria', 'ibs_cbs_classificacao_tributaria',
];

export interface FocusEmMemoria {
  /** os POST /v2/nfsen recebidos (ref + corpo), na ordem */
  emitidas: Array<{ ref: string; corpo: Record<string, unknown> }>;
  cancelamentos: Array<{ ref: string; justificativa: string }>;
  consultas: string[];
  notas: Map<string, NotaFocus>;
  /** o ambiente nacional autoriza a nota (o que a Focus faz em segundos) */
  autorizar(ref: string, numero?: string): void;
  /** próximas chamadas */
  falhas: { emitir?: Error; consultar?: Error; cancelar?: Error; cnpj?: Error };
  /** o que o cancelamento devolve (padrão `cancelado`) */
  cancelamento: CancelamentoFocus;
  cadastro: CadastroPublico | null;
  empresa: EmpresaFocus | null;
  gatilhos: GatilhoFocus[];
  tokenRecusado: boolean;
}

export function focusEmMemoria(): { focus: FocusEmMemoria; fonte: ContaFocus['fonte'] } {
  const f: FocusEmMemoria = {
    emitidas: [],
    cancelamentos: [],
    consultas: [],
    notas: new Map(),
    falhas: {},
    cancelamento: { status: 'cancelado' },
    cadastro: { razaoSocial: 'EMPRESA DE TESTE LTDA', situacao: 'ativa', optanteSimples: true, optanteMei: false, cnaePrincipal: '8650004', codigoIbge: '2100055', municipio: 'Açailândia' },
    empresa: null,
    gatilhos: [],
    tokenRecusado: false,
    autorizar(ref, numero = '1') {
      const n = f.notas.get(ref);
      if (!n) throw new Error('referência desconhecida');
      f.notas.set(ref, {
        ...n,
        status: 'autorizado',
        numero,
        codigoVerificacao: 'ABC123',
        dataEmissao: '2026-11-26T11:25:14-03:00',
        urlConsulta: `https://www.nfse.gov.br/consultapublica/?tpc=1&chave=${ref}`,
        urlDanfse: `https://focusnfe.s3.sa-east-1.amazonaws.com/arquivos/teste/DANFSEs/${ref}.pdf`,
        caminhoXml: `/arquivos/teste/XMLsNFSe/${ref}-nfse.xml`,
      });
    },
  };
  const fonte: ContaFocus['fonte'] = {
    async testar() {
      if (f.tokenRecusado) throw new ErroFocus('a Focus NFe não reconheceu o token (401)', 401);
    },
    async consultar(ref) {
      f.consultas.push(ref);
      if (f.falhas.consultar) throw f.falhas.consultar;
      return f.notas.get(ref) ?? null;
    },
    async emitir(ref, corpo): Promise<EmissaoAceita> {
      if (f.falhas.emitir) throw f.falhas.emitir;
      const falta = OBRIGATORIOS_DO_DPS.find((k) => corpo[k] === undefined || corpo[k] === null || corpo[k] === '');
      if (falta) throw new ErroFocus(`a Focus NFe recusou o pedido: O campo ${falta} é obrigatório.`, 400, 'requisicao_invalida');
      if (f.notas.has(ref)) throw new ErroFocus('a Focus NFe recusou o pedido: Já existe um DPS com esta referência.', 422, 'erro_validacao');
      f.emitidas.push({ ref, corpo });
      f.notas.set(ref, { status: 'processando_autorizacao', ref });
      return { status: 'processando_autorizacao' };
    },
    async cancelar(ref, justificativa) {
      if (f.falhas.cancelar) throw f.falhas.cancelar;
      f.cancelamentos.push({ ref, justificativa });
      const n = f.notas.get(ref);
      if (!n) throw new ErroFocus('a Focus NFe respondeu 404 (Nota fiscal não encontrada)', 404, 'nao_encontrado');
      if (f.cancelamento.status === 'cancelado') f.notas.set(ref, { ...n, status: 'cancelado' });
      return f.cancelamento;
    },
    async gatilhos() {
      return f.gatilhos;
    },
    async cnpj() {
      if (f.falhas.cnpj) throw f.falhas.cnpj;
      return f.cadastro;
    },
    async empresa() {
      return f.empresa;
    },
  };
  return { focus: f, fonte };
}
