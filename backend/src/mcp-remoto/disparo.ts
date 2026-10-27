/**
 * Disparo de campanha pelo Claude (claude.ai ou Claude Code, pelo conector): PREPARAR e MOSTRAR, nunca liberar.
 *
 * O João diz "campanha X, etiqueta Y, unidade Z". O Claude cadastra a campanha (se for nova), monta a onda e devolve o
 * LINK do painel com quantas pessoas vão receber e o texto final já com as variáveis resolvidas. Quem clica em Aprovar é
 * o João, no painel do console, com a sessão dele. Por isso NÃO existe aqui ferramenta de aprovar, de retomar onda
 * parada por SAIR nem de cancelar: a decisão que solta mensagem para paciente é dele, e a rota que a executa só aceita
 * sessão de super-admin cujo e-mail está em DISPARO_APROVADORES (a chave de serviço e este conector não entram).
 *
 * Só quem está em MCP_ESCRITA_EMAILS vê estas ferramentas (a mesma lista de quem altera cartões). Montar a onda não
 * dispara nada: cria a lista, que o Kommo e a franquia ajudam a montar, e a onda nasce esperando o clique do João.
 * Em modo seco (o padrão de toda unidade) nem o clique manda mensagem: só grava quem receberia.
 *
 * Por que o conector e não um script por ssh: o conector já tem login por pessoa (OAuth), a lista de quem pode
 * escrever e o registro de cada chamada (mcp_auditoria). Um script por ssh teria a chave de serviço do servidor, sem
 * dizer quem pediu.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { OFERTA_MAX, ROTULO_DA_EXCLUSAO, textoFinal, valoresDasVariaveis, type MotivoDeExclusao } from '../lib/disparo/regras.js';
import type { DadosDoPainel } from '../lib/disparo/painel.js';
import type { CampanhaNaLista } from '../lib/disparo/campanha.js';
import { camposDaCampanha, slugDaCampanha, type CampanhaEntrada } from '../lib/disparo/campanha-schema.js';

/** Quantas montagens podem estar em andamento ao mesmo tempo: cada uma lê o Kommo e a franquia da unidade, pessoa por pessoa. */
export const MONTAGENS_SIMULTANEAS = 2;

export type Resultado<T> = { ok: true; dados: T } | { ok: false; status: number; erro: string };

export interface OndaNaLista {
  id: string;
  campanha: string;
  unidade: string;
  etiqueta: string;
  estado: string;
  total: number;
  criadoEm: Date;
  motivo: string | null;
}

/** Tudo o que estas ferramentas precisam do mundo. Em produção, o banco; nos testes, um falso. */
export interface FonteDeDisparo {
  /** o endereço público do backend (onde o painel mora), sem barra no fim; null = não sei */
  urlDoPainel(): string | null;
  unidades(): Promise<string[]>;
  campanhas(): Promise<CampanhaNaLista[]>;
  ondasRecentes(): Promise<OndaNaLista[]>;
  montandoAgora(): Promise<number>;
  salvarCampanha(slug: string, entrada: CampanhaEntrada, opcoes: { soCriar: boolean; mesclar: boolean }): Promise<Resultado<{ id: string; slug: string; criada: boolean; alterados: string[] }>>;
  /** abre a onda em `montando` e põe a montagem para rodar em segundo plano (minutos) */
  montarOnda(a: { campanha: string; unidade: string; etiqueta: string; por: string }): Promise<Resultado<{ id: string }>>;
  tela(ondaId: string): Promise<DadosDoPainel | null>;
}

const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** "canaã", "canaa" ou "doutor-hernia-canaa" → o slug. Ambíguo ou desconhecido: erro com as opções. */
export function resolverUnidade(pedido: string, slugs: readonly string[]): string {
  const p = norm(pedido);
  if (!p) throw new ErroDeEntrada('diga a unidade (slug ou nome curto, ex.: canaa)');
  const exato = slugs.filter((s) => norm(s) === p || norm(s) === norm(`doutor-hernia-${pedido}`));
  if (exato.length === 1) return exato[0]!;
  const parecidos = exato.length ? exato : slugs.filter((s) => norm(s).includes(p));
  if (parecidos.length === 1) return parecidos[0]!;
  const opcoes = (parecidos.length ? parecidos : slugs).slice(0, 30).join(' | ');
  throw new ErroDeEntrada(`unidade "${pedido}" ${parecidos.length > 1 ? 'é ambígua' : 'não existe ou está inativa'}. Opções: ${opcoes}`);
}

export function linkDoPainel(base: string | null, ondaId: string): string | null {
  return base ? `${base.replace(/\/+$/, '')}/api/disparo/ondas/${encodeURIComponent(ondaId)}/painel` : null;
}

const ESTADO_LEGIVEL: Record<string, string> = {
  montando: 'montando a lista (leva alguns minutos)',
  montada: 'montada, esperando o João aprovar no painel',
  aprovada: 'aprovada',
  pausada: 'pausada',
  concluida: 'concluída',
  cancelada: 'cancelada',
};

function proximoPasso(d: DadosDoPainel, link: string | null): string {
  const painel = link ? `o painel (${link})` : 'o painel do console';
  switch (d.onda.estado) {
    case 'montando':
      return 'Ainda montando: consulte disparo_onda de novo em um ou dois minutos.';
    case 'montada':
      return d.modo === 'seco'
        ? `Mande o link ao João. A unidade está em MODO SECO: mesmo aprovando, nada é enviado, só se grava quem receberia. Eu não aprovo: quem clica em Aprovar em ${painel} é ele.`
        : `Mande o link ao João: quem clica em Aprovar em ${painel} é ele, e depois a unidade manda sozinha dentro da janela e dos tetos. Eu não aprovo.`;
    case 'aprovada':
      return d.modo === 'seco' ? 'Aprovada em modo seco: o worker só grava quem receberia, nada sai.' : 'Aprovada: o worker manda dentro da janela de horário e dos tetos.';
    case 'pausada':
      return d.onda.pausaCausa === 'sair'
        ? `Parou por excesso de SAIR. Só o João retoma, depois de ver quem pediu e o que escreveu, em ${painel}. Eu não retomo.`
        : `Parou: ${d.onda.pausaMotivo ?? 'sem motivo registrado'}. Não tem retomada: é cancelar no painel e montar de novo depois de resolver o motivo.`;
    case 'cancelada':
      return `Cancelada${d.onda.pausaMotivo ? `: ${d.onda.pausaMotivo}` : ''}. Para tentar de novo, monte outra onda.`;
    default:
      return 'Concluída.';
  }
}

/** O que o Claude mostra ao João: pessoas, texto final, quem ficou de fora, o modo da unidade e o link. Sem telefone de ninguém. */
export function resumoDaOnda(d: DadosDoPainel, base: string | null) {
  const exemplos = d.amostra.slice(0, 3).map((p) => ({ nome: p.nome, texto: textoFinal(d.onda.textoModelo, valoresDasVariaveis(d.onda.variaveis, { primeiroNome: p.nome, unidade: d.unidade.nome })) }));
  const link = linkDoPainel(base, d.onda.id);
  return {
    onda: d.onda.id,
    estado: d.onda.estado,
    situacao: ESTADO_LEGIVEL[d.onda.estado] ?? d.onda.estado,
    campanha: d.campanhaNome,
    unidade: d.unidade.slug,
    unidadeNome: d.unidade.nome,
    etiqueta: d.onda.etiqueta,
    pessoas: d.onda.total,
    cartoesNaEtiqueta: d.resumo.candidatos ?? null,
    foraDaLista: Object.fromEntries(Object.entries(d.resumo.fora ?? {}).filter(([, n]) => n).map(([m, n]) => [ROTULO_DA_EXCLUSAO[m as MotivoDeExclusao] ?? m, n])),
    modoDaUnidade: d.modo,
    avisoDoModo:
      d.modo === 'seco' ? 'MODO SECO: aprovar NÃO manda nada, só grava quem receberia.' : d.modo === 'desligado' ? 'Automação DESLIGADA nesta unidade: nada sai.' : 'Unidade LIGADA: aprovada, a onda sai sozinha dentro dos freios.',
    modelo: { nome: d.onda.template, idioma: d.onda.idioma, comCabecalhoDeMidia: !!d.onda.cabecalho },
    textoComoChega: exemplos,
    conferidoNaMeta: d.conferenciaMeta ? (d.conferenciaMeta.ok ? 'sim: modelo aprovado, texto e cabeçalho batem' : `NÃO: ${d.conferenciaMeta.motivo}`) : 'só é conferida enquanto a onda espera aprovação ou retomada',
    ofertaQueASofiaVaiSaber: d.oferta ?? null,
    freios: { janela: `${d.freios.janelaInicio}h às ${d.freios.janelaFim}h${d.freios.soDiasUteis ? ', dias úteis' : ''}`, tetoPorHora: d.freios.tetoPorHora, tetoPor24h: d.freios.tetoPorDia, paraSeMaisDeSair: d.freios.maxSair },
    contagemPorEstado: d.contagem,
    // Só o primeiro nome: o que cada um escreveu é texto livre de paciente e fica no painel do João, não vai para o chat.
    ...(d.saidas && d.saidas.length ? { pediramSair: { quantos: d.saidas.length, primeirosNomes: d.saidas.map((s) => s.nome), oQueEscreveram: 'só no painel do João' } } : {}),
    ...(d.onda.pausaMotivo ? { motivoDaParada: d.onda.pausaMotivo } : {}),
    painel: link,
    proximoPasso: proximoPasso(d, link),
  };
}

export async function listarDisparos(fonte: FonteDeDisparo) {
  const [campanhas, ondas] = await Promise.all([fonte.campanhas(), fonte.ondasRecentes()]);
  const base = fonte.urlDoPainel();
  return {
    campanhas: campanhas.map((c) => ({ ...c, oferta: c.oferta ?? null })),
    ondasRecentes: ondas.map((o) => ({ ...o, painel: linkDoPainel(base, o.id) })),
    lembrete: 'Aprovar e retomar onda são do João, no painel. Toda unidade nasce em MODO SECO.',
  };
}

export type EntradaDeCampanha = CampanhaEntrada & {
  /** só atualiza campanha que já existe se isto vier verdadeiro */
  atualizar?: boolean;
};

/** Cria; ou, com `atualizar`, muda SÓ o que veio (o que não veio fica como está: modelo por unidade, arte, oferta). */
export async function salvarDaFerramenta(fonte: FonteDeDisparo, slug: string, e: EntradaDeCampanha) {
  const { atualizar, ...entrada } = e;
  const r = await fonte.salvarCampanha(slug, entrada, { soCriar: !atualizar, mesclar: true });
  if (!r.ok) throw new ErroDeEntrada(r.erro);
  return {
    campanha: r.dados.slug,
    criada: r.dados.criada,
    ...(r.dados.criada ? {} : { camposAlterados: r.dados.alterados }),
    proximoPasso: 'Monte uma onda com disparo_montar_onda (campanha, unidade, etiqueta). Nada é enviado por cadastrar a campanha, e a oferta só vale para uma onda a partir de quando ela é montada (ela é copiada na montagem).',
  };
}

export async function montarDaFerramenta(fonte: FonteDeDisparo, quem: string, a: { campanha: string; unidade: string; etiqueta: string }) {
  const slug = resolverUnidade(a.unidade, await fonte.unidades());
  if ((await fonte.montandoAgora()) >= MONTAGENS_SIMULTANEAS) {
    throw new ErroDeEntrada(`já há ${MONTAGENS_SIMULTANEAS} ondas sendo montadas (cada uma lê o Kommo e a franquia da unidade): espere uma terminar e tente de novo`);
  }
  const r = await fonte.montarOnda({ campanha: a.campanha, unidade: slug, etiqueta: a.etiqueta, por: quem });
  if (!r.ok) throw new ErroDeEntrada(r.erro);
  const link = linkDoPainel(fonte.urlDoPainel(), r.dados.id);
  return {
    onda: r.dados.id,
    unidade: slug,
    situacao: ESTADO_LEGIVEL.montando,
    painel: link,
    proximoPasso: 'A lista está sendo montada (Kommo e franquia, pessoa por pessoa). Consulte disparo_onda em um ou dois minutos para ler quantas pessoas e o texto final, e então mande o link ao João. Eu não aprovo.',
  };
}

export async function ondaDaFerramenta(fonte: FonteDeDisparo, ondaId: string) {
  const d = await fonte.tela(ondaId);
  if (!d) throw new ErroDeEntrada('onda não encontrada (use disparo_listar para ver os ids)');
  return resumoDaOnda(d, fonte.urlDoPainel());
}

export function registrarDisparo(server: McpServer, fonte: FonteDeDisparo, quem: string, auditar: Auditar): void {
  server.registerTool(
    'disparo_listar',
    {
      title: 'Campanhas de disparo e ondas recentes',
      description:
        'Lista as campanhas de disparo pela API oficial do WhatsApp (modelo, texto, oferta que a Sofia vai saber, modelos próprios por unidade) e as 20 ondas mais recentes ' +
        '(unidade, etiqueta, estado, quantas pessoas, link do painel). Só leitura. Comece por aqui.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => executar('disparo_listar', {}, auditar, () => listarDisparos(fonte)),
  );

  server.registerTool(
    'disparo_campanha_salvar',
    {
      title: 'Cadastrar ou atualizar uma campanha de disparo',
      description:
        'Cria a campanha (modelo aprovado na Meta, texto, variáveis, cabeçalho por unidade e a OFERTA que a Sofia aprende). NÃO envia nada. Para CRIAR, nome e textoModelo são obrigatórios. ' +
        'Se o slug já existe, recusa, a menos que atualizar=true: confira antes o que ela tem hoje com disparo_listar. Com atualizar=true muda SÓ os campos que você mandar (o resto fica como está) e devolve quais mudaram. ' +
        '`textoModelo` é o corpo do modelo APROVADO, com {{1}}, {{2}}…; `variaveis` diz o que preenche cada um, em ordem: "primeiroNome", "unidade" ou "texto:<valor>". ' +
        '`porUnidade` traz o nome exato do modelo (o Kommo põe prefixo) e a arte de cada unidade. ' +
        `\`oferta\` é o que a Sofia dirá a quem receber e responder (preço, prazo, condições; até ${OFERTA_MAX} caracteres): ausente mantém a atual, vazio apaga.`,
      inputSchema: {
        campanha: slugDaCampanha.describe('slug, ex.: outubro-rosa-2026'),
        // os MESMOS campos da rota PUT (um schema só): mudar um limite muda os dois
        ...camposDaCampanha,
        atualizar: z.boolean().optional().describe('true para mudar uma campanha que já existe (só os campos que você mandar)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => {
      const { campanha, ...resto } = args;
      return executar('disparo_campanha_salvar', { campanha, nome: resto.nome, atualizar: resto.atualizar }, auditar, () => salvarDaFerramenta(fonte, campanha, resto));
    },
  );

  server.registerTool(
    'disparo_montar_onda',
    {
      title: 'Montar a onda de uma campanha (não envia, não aprova)',
      description:
        'Monta a lista de UMA unidade a partir de uma etiqueta do Kommo e deixa a onda esperando a aprovação do João. NÃO envia nada e NÃO aprova: ' +
        'devolve o id e o link do painel. A montagem leva alguns minutos; depois leia o resultado com disparo_onda e mande o link ao João. ' +
        'Tira da lista quem tem consulta futura ou tratamento aberto, quem pediu SAIR, quem já está na campanha e telefone ou nome inválido. ' +
        'Toda unidade nasce em modo seco: aprovada, a onda só grava quem receberia.',
      inputSchema: {
        campanha: slugDaCampanha.describe('slug da campanha cadastrada'),
        unidade: z.string().min(2).max(120).describe('UMA unidade: slug ou nome curto ("canaa")'),
        etiqueta: z.string().min(1).max(200).describe('etiqueta do Kommo que forma a lista, exatamente como está lá'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => executar('disparo_montar_onda', args, auditar, () => montarDaFerramenta(fonte, quem, args)),
  );

  server.registerTool(
    'disparo_onda',
    {
      title: 'Prévia e estado de uma onda, com o link do painel',
      description:
        'Lê uma onda: estado, quantas pessoas vão receber, o texto final com as variáveis resolvidas (3 exemplos), quem ficou de fora e por quê, ' +
        'se a Meta confere o modelo, a oferta que a Sofia vai saber, o modo da unidade (seco/ligado), quem pediu SAIR (se houver) e o LINK DO PAINEL. ' +
        'Mostre isto ao João e mande o link: aprovar, retomar e cancelar são dele, no painel. Só leitura; consulta a Meta enquanto a onda espera aprovação.',
      inputSchema: { onda: z.string().min(5).max(60).describe('id da onda (de disparo_montar_onda ou disparo_listar)') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executar('disparo_onda', args, auditar, () => ondaDaFerramenta(fonte, args.onda)),
  );
}
