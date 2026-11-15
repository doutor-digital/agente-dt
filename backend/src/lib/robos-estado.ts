/**
 * Tela «Robôs» do Chatwoot (pedido do João, 14/11/2026: "eu quero ver isso no CRM! configurar tudo isso" / "poder configurar sem precisar
 * do dev esses bots"): os robôs da régua (`chatwoot-regua.ts`) por unidade — o que cada um faz, quando manda, o texto, se está ligado, o
 * que já foi enviado — e a Gestora (administradora do Chatwoot) liga/desliga, muda o TEMPO e troca o MODELO sem precisar de código.
 *
 * ONDE FICA. Tabela nova `chatwoot_regua_robo` (migration `20261114190000`): uma linha por unidade+robô, SÓ depois que alguém mexeu (sem linha =
 * o padrão do código: ligado, tempo e modelo de fábrica). Escolhida em vez de `unit_automacoes` porque guardar tempo e modelo ali exigiria
 * enfiar JSON num campo de estado que o resto do sistema lê como `ligado|seco|desligado`. Guarda também quem mexeu por último e quando.
 *
 * O QUE O WORKER FAZ. A cada ciclo lê as linhas da unidade (`ajustesDaUnidade`): robô desligado é pulado (sem envio, sem nota, sem registrar),
 * o tempo e o modelo configurados entram no cálculo de `candidatos()` (`AjustesDaRegua`). Se não conseguir ler, o ciclo NÃO roda (nunca
 * mandar achando que está ligado um robô que a Gestora desligou). A memória do que cada conversa mostra segue em dia.
 *
 * NÃO configurável, de propósito (valem para todo robô): janela 08–20 h de segunda a sábado, `sem-follow-up` nos follow-ups, cartão ativo
 * no Kommo → só nota, não repetir (dedupe por telefone e regra|chave) e o teto de mensagens por ciclo.
 *
 * Banco injetável (`BancoDosRobos`) para testar sem Prisma: filtro por unidade/caixa e permissão ficam aqui, não no controller.
 */
import { prisma } from './prisma.js';
import { CAIXAS_CLOUD, CAIXAS_REGUA, camposDoModelo, type AjustesDaRegua } from './chatwoot-regua.js';
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';
import { catalogo, regraDoCatalogo, textoDeExemplo, type Robo } from './robos-catalogo.js';
import { TEMPO, descreverMinutos, emUnidade, etiquetaDoTempo, tempoDentroDosLimites, validarTempo, type EspecDeTempo, type UnidadeDeTempo } from './robos-tempo.js';

/** As caixas do Chatwoot que pertencem a esta unidade (a unidade nunca enxerga disparo de outra). */
export function caixasDaUnidade(slug: string, mapa: Readonly<Record<number, string>> = CAIXAS_REGUA): number[] {
  return Object.entries(mapa)
    .filter(([, s]) => s === slug)
    .map(([c]) => Number(c));
}

export interface LinhaDoRobo {
  regra: string;
  ligado: boolean;
  tempoMin: number | null;
  /** "<modelo do código>" → "<modelo que passa a mandar>" */
  modelos: Record<string, string>;
  por: string | null;
  em: Date;
}

export interface MudancaDoRobo {
  ligado?: boolean;
  /** null = volta ao tempo de fábrica */
  tempoMin?: number | null;
  /** o mapa inteiro de trocas deste robô (vazio = volta ao modelo de fábrica) */
  modelos?: Record<string, string>;
}

export interface LinhaDeDisparo {
  caixa: number;
  conversationId: number;
  regra: string;
  modo: string;
  texto: string;
  criadoEm: Date;
}

export interface BancoDosRobos {
  linhas(slug: string): Promise<LinhaDoRobo[]>;
  salvar(slug: string, regra: string, mudanca: MudancaDoRobo, por: string): Promise<void>;
  disparos(caixas: number[], desde: Date, limite: number): Promise<LinhaDeDisparo[]>;
}

const comoMapa = (v: unknown): Record<string, string> => {
  const o: Record<string, string> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') o[k] = x;
  return o;
};

export function bancoDosRobos(): BancoDosRobos {
  return {
    async linhas(slug) {
      const l = await prisma.chatwootReguaRobo.findMany({ where: { unitSlug: slug } });
      return l.map((x) => ({ regra: x.regra, ligado: x.ligado, tempoMin: x.tempoMin, modelos: comoMapa(x.modelos), por: x.atualizadoPor, em: x.atualizadoEm }));
    },
    async salvar(slug, regra, m, por) {
      const dados: { ligado?: boolean; tempoMin?: number | null; modelos?: Record<string, string>; atualizadoPor: string } = { atualizadoPor: por };
      if (m.ligado !== undefined) dados.ligado = m.ligado;
      if (m.tempoMin !== undefined) dados.tempoMin = m.tempoMin;
      if (m.modelos !== undefined) dados.modelos = m.modelos;
      await prisma.chatwootReguaRobo.upsert({
        where: { unitSlug_regra: { unitSlug: slug, regra } },
        create: { unitSlug: slug, regra, ...dados },
        update: dados,
      });
    },
    async disparos(caixas, desde, limite) {
      if (!caixas.length) return [];
      return prisma.chatwootReguaDisparo.findMany({
        where: {
          caixa: { in: caixas },
          criadoEm: { gte: desde },
          conversationId: { gt: 0 },
          // a mesma tabela guarda o rastreio de anúncios (capi-*, kapso-referral): não é robô da régua
          NOT: [{ regra: { startsWith: 'capi' } }, { regra: { startsWith: 'kapso' } }],
        },
        orderBy: { criadoEm: 'desc' },
        take: limite,
        select: { caixa: true, conversationId: true, regra: true, modo: true, texto: true, criadoEm: true },
      });
    },
  };
}

// ── o que o worker lê ─────────────────────────────────────────────────────────────────────────────

export interface AjustesDaUnidade {
  /** regras desligadas na tela «Robôs» */
  desligados: ReadonlySet<string>;
  regua: AjustesDaRegua;
}

export const SEM_AJUSTES: AjustesDaUnidade = { desligados: new Set(), regua: {} };

/** Lança se o banco falhar: o worker NÃO roda o ciclo (melhor calar um ciclo do que mandar de um robô que a Gestora desligou). */
export async function ajustesDaUnidade(banco: BancoDosRobos, slug: string): Promise<AjustesDaUnidade> {
  const linhas = await banco.linhas(slug);
  const desligados = new Set<string>();
  const tempoMin = new Map<string, number>();
  const modelos = new Map<string, string>();
  for (const l of linhas) {
    const robo = regraDoCatalogo(l.regra);
    if (!robo) continue; // linha de robô que não existe mais
    if (!l.ligado) desligados.add(l.regra);
    // valor guardado que hoje não passa nos limites (mudaram) volta ao de fábrica: nunca um horário absurdo
    if (l.tempoMin !== null && tempoDentroDosLimites(l.regra, l.tempoMin)) tempoMin.set(l.regra, l.tempoMin);
    for (const [padrao, novo] of Object.entries(l.modelos)) {
      if (robo.modelos.some((m) => m.modelo === padrao) && modeloCompativel(padrao, novo)) modelos.set(`${l.regra}|${padrao}`, novo);
    }
  }
  return { desligados, regua: { tempoMin, modelos } };
}

// ── modelos: quais podem entrar no lugar de qual ──────────────────────────────────────────────────

/** O «tipo» de cada variável do modelo, na ordem em que ele a pede: dois modelos são trocáveis se pedem os mesmos tipos na mesma ordem. */
function tipoDaVariavel(campo: string): string {
  if (campo === 'contact.name') return 'nome';
  if (campo === 'lead.cf.2450736' || campo === 'lead.cf.2450928') return 'data';
  return campo;
}
const formaDoModelo = (modelo: string): string[] => camposDoModelo(modelo).map(tipoDaVariavel);

export function modeloCompativel(padrao: string, novo: string): boolean {
  if (!(padrao in TEXTOS_PARAU) || !(novo in TEXTOS_PARAU)) return false;
  const a = formaDoModelo(padrao);
  const b = formaDoModelo(novo);
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** `nome do modelo → quantas variáveis tem o corpo na Meta` (null = não dá para saber); o que a caixa tem APROVADO. */
export type Aprovados = ReadonlyMap<string, number | null>;

export interface OpcaoDeModelo {
  modelo: string;
  texto: string | null;
}

/** Os modelos que podem mandar no lugar de `padrao`: aprovados na caixa, com as mesmas variáveis e que a régua sabe preencher. */
export function opcoesDeModelo(padrao: string, aprovados: Aprovados | null): OpcaoDeModelo[] {
  const lista = Object.keys(TEXTOS_PARAU).filter((m) => m === padrao || (modeloCompativel(padrao, m) && aprovados !== null && aprovados.has(m) && [null, camposDoModelo(m).length].includes(aprovados.get(m) ?? null)));
  return lista.sort((a, b) => (a === padrao ? -1 : b === padrao ? 1 : a.localeCompare(b))).map((modelo) => ({ modelo, texto: textoDeExemplo(modelo) }));
}

// ── o que cada linha do registro significa ─────────────────────────────────────────────────────────

export type CodigoDaSituacao = 'texto' | 'template' | 'kommo' | 'faltou-campo' | 'sem-template' | 'perdida' | 'seco' | 'interna';
export interface Situacao {
  codigo: CodigoDaSituacao;
  rotulo: string;
  /** true = foi mesmo uma mensagem ao paciente */
  enviado: boolean;
}

/** `regra` pode vir com sufixo: `!falta` (nota «faltou campo»), `!template` (template não aprovado), `!perdida` (passou do prazo). */
export function baseDaRegra(regra: string): string {
  const i = regra.indexOf('!');
  return i < 0 ? regra : regra.slice(0, i);
}

export function situacaoDoRegistro(l: Pick<LinhaDeDisparo, 'regra' | 'modo' | 'texto'>, interna = false): Situacao {
  const sufixo = l.regra.includes('!') ? l.regra.slice(l.regra.indexOf('!')) : '';
  if (sufixo === '!falta') return { codigo: 'faltou-campo', rotulo: 'Faltou um dado — não enviou', enviado: false };
  if (sufixo === '!template') return { codigo: 'sem-template', rotulo: 'Modelo ainda não aprovado — só nota', enviado: false };
  if (sufixo === '!perdida') return { codigo: 'perdida', rotulo: 'Perdida por horário — não enviou', enviado: false };
  if (l.modo === 'seco') return { codigo: 'seco', rotulo: 'Seco — só nota, nada foi enviado', enviado: false };
  if (l.texto.startsWith('🛑') && /Kommo/.test(l.texto)) return { codigo: 'kommo', rotulo: 'Só nota: o paciente tem cartão ativo no Kommo', enviado: false };
  if (interna) return { codigo: 'interna', rotulo: 'Ação interna (nota para a equipe)', enviado: false };
  if (l.texto.startsWith('[template ')) return { codigo: 'template', rotulo: 'Enviado (modelo da Meta)', enviado: true };
  return { codigo: 'texto', rotulo: 'Enviado (texto)', enviado: true };
}

export const DIAS_DO_REGISTRO = 7;
const LIMITE_DE_LINHAS = 3000;
export const MAX_ENVIADOS_NA_TELA = 200;

// ── a lista de robôs da unidade ────────────────────────────────────────────────────────────────────

export interface TempoDoRobo extends EspecDeTempo {
  /** o que vale agora (o configurado ou o de fábrica) */
  atualMin: number;
  atual: { numero: number; unidade: UnidadeDeTempo };
  personalizado: boolean;
  /** «24 h antes da consulta» com o valor de agora, e o de fábrica */
  rotulo: string;
  rotuloPadrao: string;
  minRotulo: string;
  maxRotulo: string;
}

export interface ModeloDoRoboNaTela {
  /** o modelo de fábrica deste ponto do robô */
  padrao: string;
  /** o que manda agora */
  atual: string;
  texto: string | null;
  personalizado: boolean;
  /** os que podem entrar no lugar (aprovados na caixa, mesmas variáveis); sempre inclui o de fábrica */
  opcoes: OpcaoDeModelo[];
}

export interface RoboDaUnidade extends Robo {
  ligado: boolean;
  /** quem mexeu por último e quando; null = ninguém mexeu (tudo de fábrica) */
  mudou: { por: string | null; em: string } | null;
  enviados7d: number;
  notas7d: number;
  seco7d: number;
  /** null = o robô age na hora (ou em horário fixo): nada de tempo para mudar */
  tempo: TempoDoRobo | null;
  /** um por modelo de fábrica do robô (vazio nas internas) */
  modelosDaTela: ModeloDoRoboNaTela[];
}

export interface VisaoDosRobos {
  robos: RoboDaUnidade[];
  dias: number;
  /** false = não deu para ler a lista de modelos aprovados no Chatwoot (a troca de modelo fica indisponível) */
  aprovadosLidos: boolean;
}

export async function visaoDosRobos(banco: BancoDosRobos, slug: string, o: { agora?: Date; aprovados: Aprovados | null }): Promise<VisaoDosRobos> {
  const agora = o.agora ?? new Date();
  const caixas = caixasDaUnidade(slug);
  const desde = new Date(agora.getTime() - DIAS_DO_REGISTRO * 86_400_000);
  const [linhasDoRobo, linhas] = await Promise.all([banco.linhas(slug), banco.disparos(caixas, desde, LIMITE_DE_LINHAS)]);
  const porRegra = new Map(linhasDoRobo.map((e) => [e.regra, e]));
  const conta = new Map<string, { enviados: number; notas: number; seco: number }>();
  for (const l of linhas) {
    if (!caixas.includes(l.caixa)) continue; // nunca outra unidade, mesmo que o banco devolva
    const robo = regraDoCatalogo(baseDaRegra(l.regra));
    if (!robo) continue;
    const s = situacaoDoRegistro(l, robo.interna);
    const c = conta.get(robo.regra) ?? { enviados: 0, notas: 0, seco: 0 };
    if (s.enviado) c.enviados++;
    else if (s.codigo === 'seco') c.seco++;
    else c.notas++;
    conta.set(robo.regra, c);
  }
  return {
    dias: DIAS_DO_REGISTRO,
    aprovadosLidos: o.aprovados !== null,
    robos: catalogo().map((r) => {
      const e = porRegra.get(r.regra);
      const c = conta.get(r.regra) ?? { enviados: 0, notas: 0, seco: 0 };
      const spec = TEMPO[r.regra];
      const atualMin = e?.tempoMin ?? spec?.padraoMin ?? 0;
      return {
        ...r,
        ligado: e ? e.ligado : true,
        mudou: e ? { por: e.por, em: e.em.toISOString() } : null,
        enviados7d: c.enviados,
        notas7d: c.notas,
        seco7d: c.seco,
        tempo: spec
          ? { ...spec, atualMin, atual: emUnidade(r.regra, atualMin), personalizado: e?.tempoMin != null, rotulo: etiquetaDoTempo(r.regra, atualMin), rotuloPadrao: etiquetaDoTempo(r.regra, spec.padraoMin), minRotulo: descreverMinutos(spec.minMin), maxRotulo: descreverMinutos(spec.maxMin) }
          : null,
        modelosDaTela: r.interna
          ? []
          : r.modelos.map((m) => {
              const atual = e?.modelos[m.modelo] && modeloCompativel(m.modelo, e.modelos[m.modelo]!) ? e.modelos[m.modelo]! : m.modelo;
              const opcoes = opcoesDeModelo(m.modelo, o.aprovados);
              if (!opcoes.some((x) => x.modelo === atual)) opcoes.push({ modelo: atual, texto: textoDeExemplo(atual) });
              return { padrao: m.modelo, atual, texto: textoDeExemplo(atual), personalizado: atual !== m.modelo, opcoes };
            }),
      };
    }),
  };
}

// ── mudar um robô ─────────────────────────────────────────────────────────────────────────────────

/** Só administrador do Chatwoot (João, Suzanne) mexe nos robôs; a atendente só vê. */
export const podeMexerNosRobos = (papel: string | null | undefined): boolean => papel === 'administrator';

export interface PedidoDeMudanca {
  slug: string;
  regra: unknown;
  papel: string | null | undefined;
  por: string;
  ligado?: unknown;
  /** { numero, unidade, direcao } ou null (volta ao de fábrica) */
  tempo?: unknown;
  /** { padrao, novo } — `novo` igual ao `padrao` volta ao de fábrica */
  modelo?: unknown;
  /** o que a caixa tem aprovado agora (null = não deu para ler) */
  aprovados: Aprovados | null;
}

export type ResultadoDaMudanca = { ok: true; regra: string } | { ok: false; status: 400 | 403 | 404 | 409; erro: string };

export async function mudarRobo(banco: BancoDosRobos, p: PedidoDeMudanca): Promise<ResultadoDaMudanca> {
  if (!podeMexerNosRobos(p.papel)) return { ok: false, status: 403, erro: 'só quem administra o Chatwoot configura os robôs — peça para a Suzanne ou para o João' };
  const robo = typeof p.regra === 'string' ? regraDoCatalogo(p.regra) : undefined;
  if (!robo) return { ok: false, status: 404, erro: 'robô não encontrado' };
  const mudanca: MudancaDoRobo = {};
  if (p.ligado !== undefined) {
    if (typeof p.ligado !== 'boolean') return { ok: false, status: 400, erro: 'pedido inválido' };
    mudanca.ligado = p.ligado;
  }
  if (p.tempo !== undefined) {
    if (p.tempo === null) mudanca.tempoMin = null;
    else {
      const t = p.tempo as { numero?: unknown; unidade?: unknown; direcao?: unknown };
      const v = validarTempo(robo.regra, { numero: t?.numero, unidade: t?.unidade, direcao: t?.direcao });
      if (!v.ok) return { ok: false, status: 400, erro: v.erro };
      // igual ao de fábrica = volta ao de fábrica (não deixa um «personalizado» que não muda nada)
      mudanca.tempoMin = v.minutos === TEMPO[robo.regra]!.padraoMin ? null : v.minutos;
    }
  }
  if (p.modelo !== undefined) {
    const m = p.modelo as { padrao?: unknown; novo?: unknown };
    if (robo.interna || typeof m?.padrao !== 'string' || typeof m?.novo !== 'string' || !robo.modelos.some((x) => x.modelo === m.padrao)) return { ok: false, status: 400, erro: 'pedido inválido' };
    if (p.aprovados === null && m.novo !== m.padrao) return { ok: false, status: 409, erro: 'não consegui ler os modelos aprovados no Chatwoot agora — tente de novo em instantes' };
    if (!opcoesDeModelo(m.padrao, p.aprovados).some((o) => o.modelo === m.novo)) return { ok: false, status: 400, erro: 'esse modelo não está aprovado nesta caixa ou pede variáveis diferentes das que o robô sabe preencher' };
    const atual = (await banco.linhas(p.slug)).find((l) => l.regra === robo.regra)?.modelos ?? {};
    const novo = { ...atual };
    if (m.novo === m.padrao) delete novo[m.padrao];
    else novo[m.padrao] = m.novo;
    mudanca.modelos = novo;
  }
  if (!Object.keys(mudanca).length) return { ok: false, status: 400, erro: 'nada para mudar' };
  await banco.salvar(p.slug, robo.regra, mudanca, p.por.slice(0, 80) || 'administrador');
  return { ok: true, regra: robo.regra };
}

// ── aba «Enviados» ────────────────────────────────────────────────────────────────────────────────

export interface EnviadoNaTela {
  quando: string;
  conversa: number;
  paciente: string | null;
  regra: string;
  robo: string;
  situacao: CodigoDaSituacao;
  rotulo: string;
  enviado: boolean;
}

export interface Enviados {
  dias: number;
  total: number;
  /** true = havia mais linhas que as mostradas */
  cortado: boolean;
  itens: EnviadoNaTela[];
}

/** Os últimos 7 dias da régua desta unidade, só das caixas dela e só de robôs do catálogo (nada de capi/kapso). */
export async function enviadosDaUnidade(
  banco: BancoDosRobos,
  slug: string,
  nomeDe: (conversa: number) => Promise<string | null>,
  agora: Date = new Date(),
): Promise<Enviados> {
  const caixas = caixasDaUnidade(slug);
  const desde = new Date(agora.getTime() - DIAS_DO_REGISTRO * 86_400_000);
  const linhas = (await banco.disparos(caixas, desde, LIMITE_DE_LINHAS)).filter((l) => caixas.includes(l.caixa) && l.criadoEm.getTime() >= desde.getTime());
  const validas = linhas
    .map((l) => ({ l, robo: regraDoCatalogo(baseDaRegra(l.regra)) }))
    .filter((x): x is { l: LinhaDeDisparo; robo: Robo } => !!x.robo)
    .sort((a, b) => b.l.criadoEm.getTime() - a.l.criadoEm.getTime());
  const mostradas = validas.slice(0, MAX_ENVIADOS_NA_TELA);
  // uma busca de nome por conversa (a tela mostra no máximo 200 linhas), 8 por vez
  const nomes = new Map<number, string | null>();
  const ids = [...new Set(mostradas.map(({ l }) => l.conversationId))];
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async (id) => nomes.set(id, await nomeDe(id).catch(() => null))));
  }
  return {
    dias: DIAS_DO_REGISTRO,
    total: validas.length,
    cortado: validas.length > mostradas.length,
    itens: mostradas.map(({ l, robo }) => {
      const s = situacaoDoRegistro(l, robo.interna);
      return {
        quando: l.criadoEm.toISOString(),
        conversa: l.conversationId,
        paciente: nomes.get(l.conversationId) ?? null,
        regra: robo.regra,
        robo: robo.nome,
        situacao: s.codigo,
        rotulo: s.rotulo,
        enviado: s.enviado,
      };
    }),
  };
}
