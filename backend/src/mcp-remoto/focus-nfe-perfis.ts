/**
 * O perfil fiscal de cada unidade que emite pela Focus NFe: o que o João informou (do cadastro da clínica) e que não muda de nota para nota (CNPJ, município, inscrição
 * municipal, código de tributação nacional, NBS, texto do serviço). Não é segredo: é o cadastro público da clínica. Fica no código (e não no .env) para a revisão do PR
 * conferir cada dado.
 *
 * O que NÃO está aqui de propósito, e a emissão PEDE a cada nota enquanto a contabilidade não informar: retenção, regime de apuração do Simples, regime especial,
 * situação/classificação do IBS-CBS, consumidor final e indicador do destinatário. Nunca se supõe alíquota nem retenção: a alíquota do ISS só tem valor padrão quando a unidade a
 * traz AQUI, por decisão registrada (Açailândia: 0, decisão do João por ser Simples Nacional); unidade sem `aliquotaIss` no perfil nunca emite sem alíquota informada.
 *
 * Quem informou (26/11/2026): o João, com os dados do cadastro da clínica na Focus/Asaas. NENHUM destes dados tem confirmação escrita da contabilidade. A alíquota 0 de Açailândia é decisão
 * do João (Simples Nacional: o ISS vai no DAS), e o resumo da nota diz isso (`aliquotaOrigem`). O perfil só vale para o CNPJ e o município que ele traz: se o ambiente trocar o CNPJ, a unidade NÃO emite.
 */
export interface PerfilFiscal {
  cnpj: string;
  razaoSocial: string;
  /** código IBGE (7 dígitos) do município do prestador */
  municipioIbge: string;
  municipioNome: string;
  inscricaoMunicipal: string;
  /** cTribNac, 6 dígitos sem pontos (04.08.02 = 040802) */
  codigoTributacaoNacional: string;
  /** NBS, 9 dígitos sem pontos (1.2301.92.00 = 123019200) */
  codigoNbs: string;
  descricaoDoServico: string;
  /** só informativo (não é campo do DPS) */
  cnae: string;
  /** codigo_opcao_simples_nacional: 3 = optante ME/EPP (a clínica é do Simples Nacional e, no cadastro público do CNPJ, não é MEI) */
  opcaoSimplesNacional: 1 | 2 | 3;
  /** alíquota do ISS em % (ou "parametrizada"): só existe quando a unidade a decidiu e registrou aqui; a pessoa pode trocar a cada nota */
  aliquotaIss?: number | 'parametrizada';
  /** false = a inscrição municipal fica no perfil mas NÃO vai no DPS (Açailândia: o ambiente nacional recusa com E0120, o município não tem IM no CNC da NFS-e). Padrão: envia */
  enviarIM?: boolean;
  /** false = o município NÃO está ativo no Sistema Nacional: para ME/EPP do Simples (regime 1) com ISS não retido o ambiente nacional recusa alíquota informada (E0631), então ela é omitida */
  municipioAtivoNoSistemaNacional?: boolean;
  /** total aproximado de tributos do Simples (Lei 12.741), em %: o valor REAL vem da contabilidade; sem ele a nota não sai («a completar») */
  percentualTotalTributosSimples?: number;
  /** IBS/CBS: CST, cClassTrib e cIndOp vêm da contabilidade; sem os três a nota não sai («a completar») */
  ibsCbs?: { situacaoTributaria: string; classificacaoTributaria: string; codigoIndicadorOperacao: string };
  /** de onde vieram os dados do perfil (quem informou, quando, e se a contabilidade confirmou): o resumo da nota repete isto */
  origem: string;
  /** de onde veio a alíquota, em texto, para o resumo da nota dizer a verdade */
  aliquotaOrigem?: string;
}

export const PERFIS_FISCAIS: Readonly<Record<string, PerfilFiscal>> = {
  'doutor-hernia-acailandia': {
    origem: 'informado pelo João em 26/11/2026, do cadastro da clínica; sem confirmação escrita da contabilidade',
    cnpj: '63130582000140',
    razaoSocial: 'MAGALHAES CLINICA DE FISIOTERAPIA - UNIDADE DE ACAILANDIA LTDA',
    municipioIbge: '2100055',
    municipioNome: 'Açailândia-MA',
    inscricaoMunicipal: '1000000007142',
    // E0120 (homologação): Açailândia não tem IM no CNC da NFS-e; a IM fica registrada aqui mas não vai no DPS
    enviarIM: false,
    // E0631 (homologação): município não ativo no Sistema Nacional + ME/EPP regime 1 + ISS não retido = alíquota NÃO informada
    municipioAtivoNoSistemaNacional: false,
    codigoTributacaoNacional: '040802',
    codigoNbs: '123019200',
    descricaoDoServico: 'Serviços de fisioterapia',
    cnae: '8650-0/04',
    opcaoSimplesNacional: 3,
    // decisão do João (26/11/2026): a clínica é Simples Nacional, então a alíquota do ISS informada na nota é 0 (o ISS é recolhido no DAS)
    aliquotaIss: 0,
    aliquotaOrigem: 'decisão do João em 26/11 (Simples, ISS no DAS); sem confirmação escrita da contabilidade',
  },
};

export const perfilDaUnidade = (slug: string): PerfilFiscal | undefined => PERFIS_FISCAIS[slug];
