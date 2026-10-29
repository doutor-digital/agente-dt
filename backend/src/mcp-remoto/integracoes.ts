/**
 * O que cada unidade ou empresa tem ligado no conector: CRM da franquia, Kommo, Bling, Asaas, Convênia, Tiquetaque. Sem isto, quem
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
  planilha?: Map<string, { nome: string }>;
  tramitacao?: Map<string, { nome: string }>;
}

export function listarIntegracoes(f: FontesDeIntegracao) {
  const asaas = f.asaas ?? new Map<string, { nome: string }>();
  const convenia = f.convenia ?? new Map<string, { nome: string }>();
  const tiquetaque = f.tiquetaque ?? new Map<string, { nome: string }>();
  const planilha = f.planilha ?? new Map<string, { nome: string }>();
  const tramitacao = f.tramitacao ?? new Map<string, { nome: string }>();
  const slugs = [...new Set([...f.franquia.keys(), ...f.kommo.keys(), ...f.bling.keys(), ...asaas.keys(), ...convenia.keys(), ...tiquetaque.keys(), ...planilha.keys(), ...tramitacao.keys()])].sort();
  const unidades = slugs.map((slug) => {
    const nome = f.franquia.get(slug)?.nome ?? f.kommo.get(slug)?.nome ?? f.bling.get(slug)?.nome ?? asaas.get(slug)?.nome ?? convenia.get(slug)?.nome ?? tiquetaque.get(slug)?.nome ?? planilha.get(slug)?.nome ?? tramitacao.get(slug)?.nome ?? slug;
    const tem = { franquia: f.franquia.has(slug), kommo: f.kommo.has(slug), bling: f.bling.has(slug), asaas: asaas.has(slug), convenia: convenia.has(slug), tiquetaque: tiquetaque.has(slug), planilha: planilha.has(slug), tramitacao: tramitacao.has(slug) };
    const ferramentas = [
      ...(tem.franquia ? ['franquia (pacientes, agenda, tratamentos, BI)'] : []),
      ...(tem.kommo ? ['kommo_*'] : []),
      ...(tem.franquia && tem.kommo ? ['relatorio_funil'] : []),
      ...(tem.bling ? ['bling_*'] : []),
      ...(tem.bling && tem.kommo ? ['relatorio_vendas'] : []),
      ...(tem.asaas ? ['asaas_* (cobranças, extrato, saldo)'] : []),
      ...(tem.convenia ? ['convenia_* (RH: colaboradores, admissões e desligamentos, férias, afastamentos)'] : []),
      ...(tem.tiquetaque ? ['tiquetaque_* (ponto: batidas do dia e quem está trabalhando, atrasos e faltas, horas e banco de horas, afastamentos — de todos os locais da conta)'] : []),
      ...(tem.planilha ? ['planilha_* (Google Sheets, só leitura: abas e linhas; senha descartada, CPF e telefone mascarados)'] : []),
      ...(tem.tramitacao ? ['tramitacao_* (advocacia: processos, publicações, clientes e prazos; só leitura, documentos só como metadados)'] : []),
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
    comPlanilha: unidades.filter((u) => u.planilha).length,
    comTramitacao: unidades.filter((u) => u.tramitacao).length,
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
        'tem ligado: CRM da franquia, Kommo, Bling, Asaas, Convênia (RH), Tiquetaque (ponto), planilhas do Google Sheets, Tramitação Inteligente (advocacia) — e quais ferramentas usar. Comece por aqui para saber se algo está integrado.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => executar('listar_integracoes', {}, auditar, () => listarIntegracoes(fontes())),
  );
}
