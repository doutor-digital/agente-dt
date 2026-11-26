/**
 * O que cada unidade ou empresa tem ligado no conector: CRM da franquia, Kommo, Bling, Asaas, Convênia, Tiquetaque, Tramitação (advocacia), sistema novo de RH/Caixa, ZenFisio. Sem isto, quem
 * pergunta só via `listar_unidades` — que mostra as clínicas da franquia — e concluía que a HM Tecnologia
 * "não estava conectada" (16/10/2026), com o Kommo e o Bling dela funcionando.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { executar } from './ferramenta.js';

export interface FontesDeIntegracao {
  franquia: Map<string, { nome: string }>;
  kommo: Map<string, { nome: string }>;
  bling: Map<string, { nome: string }>;
  asaas?: Map<string, { nome: string }>;
  convenia?: Map<string, { nome: string }>;
  tiquetaque?: Map<string, { nome: string }>;
  tramitacao?: Map<string, { nome: string }>;
  sistemas?: Map<string, { nome: string }>;
  zenfisio?: Map<string, { nome: string }>;
  infinitepay?: Map<string, { nome: string }>;
  /** Leitura bancária (Pluggy). Dado sensível: quem monta a sessão só passa isto para quem pode ver; para os demais fica vazio e a resposta é a de sempre. */
  pluggy?: Map<string, { nome: string }>;
  /** Ferramentas da empresa, não de uma unidade (ex. o Chatwoot do atendimento novo), só para quem tem acesso. */
  gerais?: string[];
}

export function listarIntegracoes(f: FontesDeIntegracao) {
  const asaas = f.asaas ?? new Map<string, { nome: string }>();
  const convenia = f.convenia ?? new Map<string, { nome: string }>();
  const tiquetaque = f.tiquetaque ?? new Map<string, { nome: string }>();
  const tramitacao = f.tramitacao ?? new Map<string, { nome: string }>();
  const sistemas = f.sistemas ?? new Map<string, { nome: string }>();
  const zenfisio = f.zenfisio ?? new Map<string, { nome: string }>();
  const infinitepay = f.infinitepay ?? new Map<string, { nome: string }>();
  const pluggy = f.pluggy ?? new Map<string, { nome: string }>();
  const slugs = [...new Set([...f.franquia.keys(), ...f.kommo.keys(), ...f.bling.keys(), ...asaas.keys(), ...convenia.keys(), ...tiquetaque.keys(), ...tramitacao.keys(), ...sistemas.keys(), ...zenfisio.keys(), ...infinitepay.keys(), ...pluggy.keys()])].sort();
  const unidades = slugs.map((slug) => {
    const nome = f.franquia.get(slug)?.nome ?? f.kommo.get(slug)?.nome ?? f.bling.get(slug)?.nome ?? asaas.get(slug)?.nome ?? convenia.get(slug)?.nome ?? tiquetaque.get(slug)?.nome ?? tramitacao.get(slug)?.nome ?? sistemas.get(slug)?.nome ?? zenfisio.get(slug)?.nome ?? infinitepay.get(slug)?.nome ?? pluggy.get(slug)?.nome ?? slug;
    const tem = { franquia: f.franquia.has(slug), kommo: f.kommo.has(slug), bling: f.bling.has(slug), asaas: asaas.has(slug), convenia: convenia.has(slug), tiquetaque: tiquetaque.has(slug), tramitacao: tramitacao.has(slug), sistemas: sistemas.has(slug), zenfisio: zenfisio.has(slug), infinitepay: infinitepay.has(slug), ...(pluggy.size ? { pluggy: pluggy.has(slug) } : {}) };
    const ferramentas = [
      ...(tem.franquia ? ['franquia (pacientes, agenda, tratamentos, BI)'] : []),
      ...(tem.kommo ? ['kommo_*'] : []),
      ...(tem.franquia && tem.kommo ? ['relatorio_funil'] : []),
      ...(tem.bling ? ['bling_*'] : []),
      ...(tem.bling && tem.kommo ? ['relatorio_vendas'] : []),
      ...(tem.asaas ? ['asaas_* (cobranças, extrato, saldo, clientes; para quem tem permissão, também criar cobrança por boleto/Pix/cartão, editar, cancelar, estornar e transferir para destinos da lista, direto e com tetos)'] : []),
      ...(tem.convenia ? ['convenia_* (RH: colaboradores, admissões e desligamentos, férias, afastamentos)'] : []),
      ...(tem.tiquetaque ? ['tiquetaque_* (ponto: batidas do dia e quem está trabalhando, atrasos e faltas, horas e banco de horas, afastamentos — de todos os locais da conta)'] : []),
      ...(tem.tramitacao ? ['tramitacao_* (advocacia: processos, publicações, clientes e prazos; só leitura, documentos só como metadados)'] : []),
      ...(tem.sistemas ? ['sistemas_* (sistema novo de RH/Caixa/Financeiro: esquema, consulta, usuários, log, simulação; alterar em dois passos para quem tem permissão)'] : []),
      ...(tem.zenfisio ? ['zenfisio_* (clínica de fisioterapia: agenda com status, faltas e taxa de falta, profissionais, pacotes; só leitura)'] : []),
      ...(tem.infinitepay ? ['infinitepay_* (status de um pagamento e os links de pagamento criados pelo conector; a API da InfinitePay NÃO lista vendas, Pix, saldo, extrato nem recebíveis)'] : []),
      ...(tem.pluggy ? ['pluggy_* (leitura bancária via Open Finance: contas com saldo, extrato e resumo por dia/semana; só leitura, só para quem altera cartões; traz a data da última sincronização)'] : []),
    ];
    return { slug, nome, ...tem, ferramentas };
  });
  return {
    total: unidades.length,
    comFranquia: unidades.filter((u) => u.franquia).length,
    comKommo: unidades.filter((u) => u.kommo).length,
    comBling: unidades.filter((u) => u.bling).length,
    comAsaas: unidades.filter((u) => u.asaas).length,
    comConvenia: unidades.filter((u) => u.convenia).length,
    comTiquetaque: unidades.filter((u) => u.tiquetaque).length,
    comTramitacao: unidades.filter((u) => u.tramitacao).length,
    comSistemas: unidades.filter((u) => u.sistemas).length,
    comZenfisio: unidades.filter((u) => u.zenfisio).length,
    comInfinitepay: unidades.filter((u) => u.infinitepay).length,
    // só aparece para quem vê a leitura bancária: para os demais a resposta é a de antes
    ...(pluggy.size ? { comPluggy: unidades.filter((u) => 'pluggy' in u && u.pluggy).length } : {}),
    ferramentasGerais: f.gerais ?? [],
    unidades,
    observacao: 'Anúncios (Meta Ads e Google Ads) ainda não estão neste conector.',
  };
}

export function registrarIntegracoes(server: McpServer, fontes: () => FontesDeIntegracao, auditar?: Auditar): void {
  server.registerTool(
    'listar_integracoes',
    {
      title: 'O que está ligado em cada unidade',
      description:
        'Todas as unidades e empresas do conector (clínicas Doutor Hérnia e empresas do grupo, como a HM Tecnologia) e o que cada uma ' +
        'tem ligado: CRM da franquia, Kommo, Bling, Asaas (leitura; para quem tem permissão, também cria cobrança por boleto/Pix/cartão, edita, cancela, estorna e transfere para destinos da lista, direto e com tetos), Convênia (RH), Tiquetaque (ponto), Tramitação Inteligente (advocacia), sistema novo de RH/Caixa/Financeiro (sistemas_*), ZenFisio (zenfisio_*: agenda da clínica de fisioterapia), InfinitePay (infinitepay_*: status de um pagamento e os links criados pelo conector; a API dela não lista vendas, saldo nem extrato) — e quais ferramentas usar. Comece por aqui para saber se algo está integrado.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => executar('listar_integracoes', {}, auditar, () => listarIntegracoes(fontes())),
  );
}
