/**
 * O que cada unidade ou empresa tem ligado no conector: CRM da franquia, Kommo, Bling, Asaas, Convênia, Tiquetaque, sistema novo de RH/Caixa. Sem isto, quem
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
  sistemas?: Map<string, { nome: string }>;
}

export function listarIntegracoes(f: FontesDeIntegracao) {
  const asaas = f.asaas ?? new Map<string, { nome: string }>();
  const convenia = f.convenia ?? new Map<string, { nome: string }>();
  const tiquetaque = f.tiquetaque ?? new Map<string, { nome: string }>();
  const sistemas = f.sistemas ?? new Map<string, { nome: string }>();
  const slugs = [...new Set([...f.franquia.keys(), ...f.kommo.keys(), ...f.bling.keys(), ...asaas.keys(), ...convenia.keys(), ...tiquetaque.keys(), ...sistemas.keys()])].sort();
  const unidades = slugs.map((slug) => {
    const nome = f.franquia.get(slug)?.nome ?? f.kommo.get(slug)?.nome ?? f.bling.get(slug)?.nome ?? asaas.get(slug)?.nome ?? convenia.get(slug)?.nome ?? tiquetaque.get(slug)?.nome ?? sistemas.get(slug)?.nome ?? slug;
    const tem = { franquia: f.franquia.has(slug), kommo: f.kommo.has(slug), bling: f.bling.has(slug), asaas: asaas.has(slug), convenia: convenia.has(slug), tiquetaque: tiquetaque.has(slug), sistemas: sistemas.has(slug) };
    const ferramentas = [
      ...(tem.franquia ? ['franquia (pacientes, agenda, tratamentos, BI)'] : []),
      ...(tem.kommo ? ['kommo_*'] : []),
      ...(tem.franquia && tem.kommo ? ['relatorio_funil'] : []),
      ...(tem.bling ? ['bling_*'] : []),
      ...(tem.bling && tem.kommo ? ['relatorio_vendas'] : []),
      ...(tem.asaas ? ['asaas_* (cobranças, extrato, saldo)'] : []),
      ...(tem.convenia ? ['convenia_* (RH: colaboradores, admissões e desligamentos, férias, afastamentos)'] : []),
      ...(tem.tiquetaque ? ['tiquetaque_* (ponto: batidas do dia e quem está trabalhando, atrasos e faltas, horas e banco de horas, afastamentos — de todos os locais da conta)'] : []),
      ...(tem.sistemas ? ['sistemas_* (sistema novo de RH/Caixa/Financeiro: esquema, consulta, usuários, log, simulação; alterar em dois passos para quem tem permissão)'] : []),
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
    comSistemas: unidades.filter((u) => u.sistemas).length,
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
        'tem ligado: CRM da franquia, Kommo, Bling, Asaas, Convênia (RH), Tiquetaque (ponto) — e quais ferramentas usar. Comece por aqui para saber se algo está integrado.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => executar('listar_integracoes', {}, auditar, () => listarIntegracoes(fontes())),
  );
}
