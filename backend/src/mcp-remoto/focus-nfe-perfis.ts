/**
 * O perfil fiscal de cada unidade que emite pela Focus NFe: o que a CONTABILIDADE e o João já informaram e que não muda de nota para nota (CNPJ, município, inscrição
 * municipal, código de tributação nacional, NBS, texto do serviço). Não é segredo: é o cadastro público da clínica. Fica no código (e não no .env) para a revisão do PR
 * conferir cada dado.
 *
 * O que NÃO está aqui de propósito, e a emissão PEDE a cada nota enquanto a contabilidade não informar: alíquota do ISS, retenção, regime de apuração do Simples,
 * regime especial, situação/classificação do IBS-CBS, consumidor final e indicador do destinatário. Nunca se supõe alíquota nem retenção.
 *
 * Quem informou (26/11/2026): o João, com os dados do cadastro da clínica na Focus/Asaas. A alíquota do ISS segue PENDENTE com a contabilidade.
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
}

export const PERFIS_FISCAIS: Readonly<Record<string, PerfilFiscal>> = {
  'doutor-hernia-acailandia': {
    cnpj: '63130582000140',
    razaoSocial: 'MAGALHAES CLINICA DE FISIOTERAPIA - UNIDADE DE ACAILANDIA LTDA',
    municipioIbge: '2100055',
    municipioNome: 'Açailândia-MA',
    inscricaoMunicipal: '1000000007142',
    codigoTributacaoNacional: '040802',
    codigoNbs: '123019200',
    descricaoDoServico: 'Serviços de fisioterapia',
    cnae: '8650-0/04',
    opcaoSimplesNacional: 3,
  },
};

export const perfilDaUnidade = (slug: string): PerfilFiscal | undefined => PERFIS_FISCAIS[slug];
