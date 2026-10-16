/**
 * O que cada unidade ou empresa tem ligado no conector: CRM da franquia, Kommo, Bling. Sem isto, quem
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
}

export function listarIntegracoes(f: FontesDeIntegracao) {
  const slugs = [...new Set([...f.franquia.keys(), ...f.kommo.keys(), ...f.bling.keys()])].sort();
  const unidades = slugs.map((slug) => {
    const nome = f.franquia.get(slug)?.nome ?? f.kommo.get(slug)?.nome ?? f.bling.get(slug)?.nome ?? slug;
    const tem = { franquia: f.franquia.has(slug), kommo: f.kommo.has(slug), bling: f.bling.has(slug) };
    const ferramentas = [
      ...(tem.franquia ? ['franquia (pacientes, agenda, tratamentos, BI)'] : []),
      ...(tem.kommo ? ['kommo_*'] : []),
      ...(tem.franquia && tem.kommo ? ['relatorio_funil'] : []),
      ...(tem.bling ? ['bling_*'] : []),
      ...(tem.bling && tem.kommo ? ['relatorio_vendas'] : []),
    ];
    return { slug, nome, ...tem, ferramentas };
  });
  return {
    total: unidades.length,
    comFranquia: unidades.filter((u) => u.franquia).length,
    comKommo: unidades.filter((u) => u.kommo).length,
    comBling: unidades.filter((u) => u.bling).length,
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
        'tem ligado: CRM da franquia, Kommo, Bling — e quais ferramentas usar. Comece por aqui para saber se algo está integrado.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => executar('listar_integracoes', {}, auditar, () => listarIntegracoes(fontes())),
  );
}
