/**
 * Eventos de conversão mandados para a Meta (CAPI) pelo n8n — o que o conector mostra para responder
 * "está saindo evento para a Meta dos nossos leads?". Lê as tabelas de rastreio do n8n (`n8n_rastreio`),
 * só leitura, com um usuário de banco que só tem SELECT nelas.
 *
 * - capi_envios: cada evento por lead (ViewContent, LeadSubmitted, AddToCart, InitiateCheckout, Purchase),
 *   com status reservado | enviado | falhou | simulado e a resposta da Meta.
 * - ctwa_eventos: cada clique em anúncio de WhatsApp (o que permite casar o lead com o anúncio).
 * - capi_descartes: evento que NÃO saiu e por quê (sem clique de anúncio, funil fora do mapa…). Não tem
 *   unidade, então só aparece na consulta de um lead.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, validarData } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { epochDoDiaLocal } from './tempo.js';

export interface FonteRastreio {
  consultar<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

const FUSO = 'America/Sao_Paulo';
const EVENTOS = ['ViewContent', 'LeadSubmitted', 'AddToCart', 'InitiateCheckout', 'Purchase'] as const;
const SIGNIFICADO: Record<string, string> = {
  ViewContent: 'mensagem de quem clicou no anúncio',
  LeadSubmitted: 'lead quente (qualificado)',
  AddToCart: 'agendou',
  InitiateCheckout: 'compareceu',
  Purchase: 'fechou tratamento',
};

/** "doutor-hernia-boa-vista", "boa vista" e "boavista" viram a mesma chave — o n8n usa "boavista"/"rioverde". */
export function chaveDaUnidade(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^doutor-hernia-/, '').replace(/[^a-z]/g, '');
}

function periodo(inicio: string, fim: string): { de: Date; ate: Date } {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (fim < inicio) throw new ErroDeEntrada('fim antes do início');
  return { de: new Date(epochDoDiaLocal(inicio, FUSO) * 1000), ate: new Date(epochDoDiaLocal(fim, FUSO, true) * 1000) };
}

interface LinhaEnvio { unidade: string; event_name: string; status: string; n: number; ultimo: Date | null }
interface LinhaClique { unidade: string; cliques: number; pessoas: number }

export function montarPainelDeEventos(envios: LinhaEnvio[], cliques: LinhaClique[], unidades: string[] | null, agora = new Date()) {
  const porUnidade: Record<string, {
    cliquesEmAnuncio: number;
    pessoasQueClicaram: number;
    eventos: Record<string, { significa: string; enviados: number; falharam: number; pendentes: number }>;
    ultimoEnvio: string | null;
    alertas: string[];
  }> = {};
  const garantir = (u: string) => (porUnidade[u] ??= { cliquesEmAnuncio: 0, pessoasQueClicaram: 0, eventos: {}, ultimoEnvio: null, alertas: [] });
  for (const u of unidades ?? []) garantir(u);
  for (const c of cliques) { const o = garantir(c.unidade); o.cliquesEmAnuncio = Number(c.cliques); o.pessoasQueClicaram = Number(c.pessoas); }
  for (const e of envios) {
    const o = garantir(e.unidade);
    const ev = (o.eventos[e.event_name] ??= { significa: SIGNIFICADO[e.event_name] ?? e.event_name, enviados: 0, falharam: 0, pendentes: 0 });
    const n = Number(e.n);
    if (e.status === 'enviado') ev.enviados += n;
    else if (e.status === 'falhou') ev.falharam += n;
    else if (e.status === 'reservado') ev.pendentes += n;
    const ult = e.ultimo ? new Date(e.ultimo).toISOString() : null;
    if (ult && (!o.ultimoEnvio || ult > o.ultimoEnvio)) o.ultimoEnvio = ult;
  }
  for (const [u, o] of Object.entries(porUnidade)) {
    for (const nome of EVENTOS) o.eventos[nome] ??= { significa: SIGNIFICADO[nome]!, enviados: 0, falharam: 0, pendentes: 0 };
    const falhas = Object.values(o.eventos).reduce((s, x) => s + x.falharam, 0);
    if (falhas) o.alertas.push(`${falhas} evento(s) recusado(s) pela Meta`);
    if (!o.ultimoEnvio) o.alertas.push('nenhum evento enviado no período');
    else if (agora.getTime() - Date.parse(o.ultimoEnvio) > 48 * 3_600_000) o.alertas.push('nenhum evento enviado há mais de 48 h');
    if (o.cliquesEmAnuncio > 0 && o.eventos.LeadSubmitted!.enviados === 0) o.alertas.push('teve clique em anúncio e nenhum lead quente foi para a Meta (qualificação não preenchida?)');
    void u;
  }
  const lista = Object.values(porUnidade);
  const soma = (k: (typeof EVENTOS)[number]) => lista.reduce((s, o) => s + (o.eventos[k]?.enviados ?? 0), 0);
  return {
    rede: {
      unidades: lista.length,
      cliquesEmAnuncio: lista.reduce((s, o) => s + o.cliquesEmAnuncio, 0),
      enviados: Object.fromEntries(EVENTOS.map((k) => [k, soma(k)])),
      falharam: lista.reduce((s, o) => s + Object.values(o.eventos).reduce((t, x) => t + x.falharam, 0), 0),
      comAlerta: Object.entries(porUnidade).filter(([, o]) => o.alertas.length).map(([u]) => u),
    },
    porUnidade,
  };
}

export async function metaEventos(fonte: FonteRastreio, a: { unidade: string | string[]; inicio: string; fim: string }) {
  const { de, ate } = periodo(a.inicio, a.fim);
  const pedidos = (Array.isArray(a.unidade) ? a.unidade : [a.unidade]).map(chaveDaUnidade);
  const todas = pedidos.includes('todas');
  const filtro = todas ? null : pedidos;
  const envios = await fonte.consultar<LinhaEnvio>(
    `select unidade, event_name, status, count(*)::int as n, max(enviado_em) as ultimo
       from capi_envios where reservado_em >= $1 and reservado_em <= $2 ${filtro ? 'and unidade = any($3)' : ''}
      group by 1, 2, 3`,
    de, ate, ...(filtro ? [filtro] : []),
  );
  const cliques = await fonte.consultar<LinhaClique>(
    `select unidade, count(*)::int as cliques, count(distinct telefone_digits)::int as pessoas
       from ctwa_eventos where primeiro_contato_em >= $1 and primeiro_contato_em <= $2 ${filtro ? 'and unidade = any($3)' : ''}
      group by 1`,
    de, ate, ...(filtro ? [filtro] : []),
  );
  if (filtro && envios.length === 0 && cliques.length === 0) {
    const conhecidas = (await fonte.consultar<{ unidade: string }>('select distinct unidade from capi_envios order by 1')).map((x) => x.unidade);
    const faltam = filtro.filter((f) => !conhecidas.includes(f));
    if (faltam.length) throw new ErroDeEntrada(`unidade sem rastreio de eventos: ${faltam.join(', ')}. Com rastreio: ${conhecidas.join(', ')}`);
  }
  return {
    periodo: { inicio: a.inicio, fim: a.fim },
    ...montarPainelDeEventos(envios, cliques, filtro),
    observacao: 'Eventos saem do n8n para a Meta pelo clique em anúncio de WhatsApp: lead sem clique (orgânico, indicação) não gera evento. ' +
      'A Meta mostra esses eventos no Gerenciador de Eventos; a API de estatísticas dela não cobre evento de mensagem.',
  };
}

export async function metaEventosDoLead(fonte: FonteRastreio, a: { leadId: number }) {
  const id = String(a.leadId);
  const envios = await fonte.consultar<{ unidade: string; event_name: string; status: string; http_status: number | null; reservado_em: Date; enviado_em: Date | null; ctwa_clid: string | null; erro: string | null }>(
    `select unidade, event_name, status, http_status, reservado_em, enviado_em, ctwa_clid,
            case when status = 'falhou' then left(resposta::text, 200) end as erro
       from capi_envios where kommo_lead_id = $1 order by reservado_em`,
    id,
  );
  const descartes = await fonte.consultar<{ motivo: string; event_name: string; vezes: number; ultima: Date }>(
    `select motivo, event_name, count(*)::int as vezes, max(em) as ultima
       from capi_descartes where kommo_lead_id = $1 and em > now() - interval '90 days'
      group by 1, 2 order by 4 desc limit 20`,
    id,
  );
  const quando = (d: Date | null) => (d ? new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d)) : null);
  const MOTIVO: Record<string, string> = {
    sem_ctwa_clid: 'o lead não veio de clique em anúncio de WhatsApp (sem identificação do anúncio), então a Meta não tem com o que casar',
    unidade_fora_do_mapa: 'o cartão está num funil que o rastreio não acompanha (ex.: TRATAMENTO)',
  };
  return {
    leadId: a.leadId,
    unidade: envios[0]?.unidade ?? null,
    veioDeAnuncio: envios.some((e) => e.ctwa_clid),
    eventos: envios.map((e) => ({ evento: e.event_name, significa: SIGNIFICADO[e.event_name] ?? e.event_name, status: e.status, em: quando(e.enviado_em ?? e.reservado_em), ...(e.erro ? { erro: e.erro } : {}) })),
    naoSairam: descartes.map((d) => ({ evento: d.event_name, motivo: MOTIVO[d.motivo] ?? d.motivo, vezes: d.vezes, ultima: quando(d.ultima) })),
  };
}

const data = (o: string) => z.string().describe(`${o}, AAAA-MM-DD`);

export function registrarMetaEventos(server: McpServer, fonte: () => FonteRastreio | null, auditar?: Auditar): void {
  const exigir = () => {
    const f = fonte();
    if (!f) throw new ErroDeEntrada('a leitura dos eventos da Meta não está ligada neste servidor (falta RASTREIO_DATABASE_URL)');
    return f;
  };
  server.registerTool(
    'meta_eventos',
    {
      title: 'Eventos enviados para a Meta (CAPI)',
      description:
        'Se está saindo evento de conversão para a Meta, por unidade e período: cliques em anúncio de WhatsApp, e quantos eventos foram ' +
        'enviados, recusados ou estão pendentes — ViewContent (mensagem), LeadSubmitted (lead quente), AddToCart (agendou), ' +
        'InitiateCheckout (compareceu), Purchase (fechou). Traz alertas (recusa, nada enviado há 48 h, clique sem lead quente). ' +
        'unidade aceita nome curto, lista ou "todas".',
      inputSchema: {
        unidade: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
        inicio: data('início'),
        fim: data('fim'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('meta_eventos', args, auditar, () => metaEventos(exigir(), args)),
  );
  server.registerTool(
    'meta_eventos_lead',
    {
      title: 'Eventos da Meta de um lead',
      description:
        'Para UM cartão do Kommo: quais eventos foram para a Meta (com data e status) e quais NÃO saíram e por quê ' +
        '(ex.: o lead não veio de clique em anúncio). Use para explicar por que um lead não aparece como conversão no anúncio.',
      inputSchema: { leadId: z.number().int().positive().describe('número do cartão no Kommo') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('meta_eventos_lead', args, auditar, () => metaEventosDoLead(exigir(), args)),
  );
}
