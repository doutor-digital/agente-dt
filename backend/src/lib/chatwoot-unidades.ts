/**
 * CONFIGURAÇÃO DO CRM (CHATWOOT) POR UNIDADE (kit de unidade nova, 14/11/2026).
 *
 * Até aqui "qual caixa é de qual unidade", o gerente da caixa, o usuário do celular, o prefixo dos modelos do WhatsApp (`parau_`),
 * o número do Kapso e a WABA estavam escritos no código, só para Parauapebas. Aqui moram como DADO, por unidade: a tabela
 * `unit_chatwoot` (+ `unit_chatwoot_caixa`), lida no boot e revalidada, no mesmo desenho de `automacoes-estado.ts` — as portas
 * continuam SÍNCRONAS (mapa em memória), porque são chamadas no meio de laços de worker e de webhook.
 *
 * COMPATIBILIDADE: os mapas antigos (`CAIXAS_REGUA`, `CAIXAS_CLOUD`, `CAIXAS_HISTORICO`, `GERENTE_DA_CAIXA`,
 * `META_AGENDAMENTOS_POR_CAIXA`, `INSTANCIA_CAIXA`, `CAIXAS_CAPI`) seguem existindo com o mesmo nome e o mesmo formato, mas
 * agora são DERIVADOS da configuração e atualizados NO LUGAR (mesmo objeto): quem os importou enxerga a mudança sem mudar uma linha.
 *
 * SEGURANÇA DO CAMINHO ANTIGO: `SEMENTE_PARAUAPEBAS` é exatamente o que estava no código. Sem linha no banco para Parauapebas
 * (tabela vazia, migration ainda não rodou, banco fora do ar), ela vale — comportamento idêntico ao de antes. Linha no banco VENCE a
 * semente da mesma unidade. Linha inválida (caixa repetida em duas unidades, prefixo repetido, sem caixa) é ignorada com aviso.
 *
 * Este arquivo é PURO (sem banco nem rede), como `chatwoot-regua.ts`, que o importa. A leitura do banco está em `chatwoot-unidades-banco.ts`.
 *
 * SEGREDO NUNCA MORA AQUI: o token da Meta e o dataset ficam no ambiente (`META_ADS_TOKEN_<SUFIXO>`); aqui só o SUFIXO.
 */

export type TipoDeCaixa = 'cloud' | 'evolution' | 'historico';

export interface CaixaConfig {
  /** id da caixa (inbox) no Chatwoot — único na conta */
  id: number;
  tipo: TipoDeCaixa;
  /** instância do Evolution que alimenta a caixa (só `evolution`) */
  instanciaEvolution?: string | null;
}

/** Os dados que entram NO TEXTO dos modelos do WhatsApp (ficam gravados no corpo aprovado na Meta). */
export interface DadosDosModelos {
  /** "Doutor Hérnia Parauapebas" */
  nome: string;
  /** "Parauapebas" */
  cidade: string;
  /** endereço completo, como vai no modelo */
  endereco: string;
  /** link do mapa ("Como chegar") */
  mapa: string;
  telefone?: string;
  /** "R$ 350" — só os modelos que citarem valor fixo usam; a régua atual manda o valor por variável */
  valorConsulta?: string;
  valorComSinal?: string;
}

export interface ConfigChatwootUnidade {
  slug: string;
  /** prefixo dos modelos na Meta, com o "_" no fim ("parau_") */
  prefixoModelos: string;
  usuarioCelularId: number | null;
  gerenteId: number | null;
  metaAgendamentosDia: number | null;
  kapsoPhoneNumberId: string | null;
  wabaId: string | null;
  /** sufixo das variáveis META_ADS_TOKEN_<SUFIXO> / META_DATASET_ID_<SUFIXO> */
  envSufixo: string;
  dadosModelos: DadosDosModelos;
  caixas: CaixaConfig[];
}

/** O que estava escrito no código antes desta mudança. Não editar para "ajustar": o teste compara com o comportamento antigo. */
export const SEMENTE_PARAUAPEBAS: ConfigChatwootUnidade = {
  slug: 'doutor-hernia-parauapebas',
  prefixoModelos: 'parau_',
  usuarioCelularId: 7,
  gerenteId: 4,
  metaAgendamentosDia: 5,
  kapsoPhoneNumberId: '1212928641906230',
  wabaId: '2146287749563217',
  envSufixo: 'PARAUAPEBAS',
  dadosModelos: {
    nome: 'Doutor Hérnia Parauapebas',
    cidade: 'Parauapebas',
    endereco: 'Rua C, 455-A, Sala 101 e 103 — Cidade Nova, Parauapebas/PA, 68515-000',
    mapa: 'https://share.google/LzWt0AQhG4HWTpWOq',
  },
  caixas: [
    { id: 2, tipo: 'evolution', instanciaEvolution: 'parauapebas-unidade' }, // Evolution (desconectado desde 13/11: o número entrou no Kapso)
    { id: 3, tipo: 'cloud' }, // WhatsApp Cloud via Kapso (13/11/2026)
    { id: 4, tipo: 'historico' }, // histórico antigo do app do celular, importado do Kapso (canal API, não envia nada)
  ],
};

// ── validação (pura) ─────────────────────────────────────────────────────────────────────────────

/** Problemas de uma configuração SOZINHA. Vazio = ok. */
export function problemasDaConfig(c: ConfigChatwootUnidade): string[] {
  const p: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(c.slug)) p.push(`slug inválido (${c.slug})`);
  if (!/^[a-z][a-z0-9]{1,15}_$/.test(c.prefixoModelos)) p.push(`prefixo dos modelos inválido (${c.prefixoModelos}): minúsculas/dígitos terminando em "_"`);
  if (!/^[A-Z][A-Z0-9_]*$/.test(c.envSufixo)) p.push(`sufixo das variáveis inválido (${c.envSufixo}): maiúsculas, dígitos e "_"`);
  if (!c.caixas.length) p.push('sem nenhuma caixa');
  const ids = new Set<number>();
  for (const cx of c.caixas) {
    if (!Number.isInteger(cx.id) || cx.id <= 0) p.push(`caixa com id inválido (${cx.id})`);
    if (ids.has(cx.id)) p.push(`caixa ${cx.id} repetida`);
    ids.add(cx.id);
    if (cx.tipo !== 'cloud' && cx.tipo !== 'evolution' && cx.tipo !== 'historico') p.push(`caixa ${cx.id}: tipo inválido (${String(cx.tipo)})`);
  }
  for (const k of ['nome', 'cidade', 'endereco', 'mapa'] as const) if (!c.dadosModelos?.[k]?.trim()) p.push(`dados dos modelos: falta ${k}`);
  if (c.dadosModelos?.mapa && !/^https:\/\/\S+$/.test(c.dadosModelos.mapa)) p.push('dados dos modelos: o mapa precisa ser um link https');
  if (c.kapsoPhoneNumberId && !/^\d{5,25}$/.test(c.kapsoPhoneNumberId)) p.push('número do Kapso (phone_number_id) inválido');
  if (c.wabaId && !/^\d{5,25}$/.test(c.wabaId)) p.push('WABA inválida');
  return p;
}

/** Problemas ENTRE unidades: a mesma caixa ou o mesmo prefixo em duas unidades. Devolve os slugs que devem ser descartados (os últimos). */
export function conflitosEntreUnidades(lista: readonly ConfigChatwootUnidade[]): Map<string, string> {
  const ruins = new Map<string, string>();
  const caixaDe = new Map<number, string>();
  const prefixoDe = new Map<string, string>();
  for (const c of lista) {
    for (const cx of c.caixas) {
      const dono = caixaDe.get(cx.id);
      if (dono && dono !== c.slug) ruins.set(c.slug, `a caixa ${cx.id} já é de ${dono}`);
      else caixaDe.set(cx.id, c.slug);
    }
    const dono = prefixoDe.get(c.prefixoModelos);
    if (dono && dono !== c.slug) ruins.set(c.slug, `o prefixo ${c.prefixoModelos} já é de ${dono}`);
    else prefixoDe.set(c.prefixoModelos, c.slug);
  }
  return ruins;
}

// ── os mapas derivados (objetos VIVOS: atualizados no lugar) ─────────────────────────────────────

// Por dentro são mapas mutáveis (`aplicarConfigs` os atualiza NO LUGAR); por fora têm o tipo somente-leitura de sempre.
const caixasRegua: Record<number, string> = {};
const caixasCloud: Set<number> = new Set();
const caixasHistorico: Set<number> = new Set();
const gerenteDaCaixa: Record<number, number> = {};
const metaPorCaixa: Record<number, number> = {};
const instanciaCaixa: Record<string, number> = {};
const caixasCapi: Record<number, { slug: string; waba: string }> = {};
const usuariosCelular: Set<number> = new Set();

/** caixa → slug da unidade (só caixas que falam com paciente: cloud e evolution). */
export const CAIXAS_REGUA: Readonly<Record<number, string>> = caixasRegua;
/** Caixas de canal WhatsApp Cloud (oficial, via Kapso): fora da janela de 24 h só vai TEMPLATE aprovado. */
export const CAIXAS_CLOUD: ReadonlySet<number> = caixasCloud;
/** Caixas só de HISTÓRICO: arquivo, fora da régua, da agenda, do funil e do Hoje. */
export const CAIXAS_HISTORICO: ReadonlySet<number> = caixasHistorico;
/** caixa → agente gerente no Chatwoot (lead quente parado vai para ela). */
export const GERENTE_DA_CAIXA: Readonly<Record<number, number>> = gerenteDaCaixa;
/** caixa → meta de agendamentos por dia. */
export const META_AGENDAMENTOS_POR_CAIXA: Readonly<Record<number, number>> = metaPorCaixa;
/** instância do Evolution → caixa do Chatwoot. */
export const INSTANCIA_CAIXA: Readonly<Record<string, number>> = instanciaCaixa;
/** caixa (só oficial) → unidade e a WABA da caixa. */
export const CAIXAS_CAPI: Readonly<Record<number, { slug: string; waba: string }>> = caixasCapi;

let configs: ReadonlyMap<string, ConfigChatwootUnidade> = new Map();

function esvaziar(o: Record<string | number, unknown>): void {
  for (const k of Object.keys(o)) delete o[k];
}

/**
 * Recalcula todos os mapas a partir da lista. Pura em relação ao banco; síncrona do começo ao fim (nenhum `await`), então quem lê
 * os mapas nunca vê um estado pela metade.
 */
export function aplicarConfigs(lista: readonly ConfigChatwootUnidade[]): void {
  esvaziar(caixasRegua);
  esvaziar(gerenteDaCaixa);
  esvaziar(metaPorCaixa);
  esvaziar(instanciaCaixa);
  esvaziar(caixasCapi);
  caixasCloud.clear();
  caixasHistorico.clear();
  usuariosCelular.clear();
  const porSlug = new Map<string, ConfigChatwootUnidade>();
  for (const c of lista) {
    porSlug.set(c.slug, c);
    if (c.usuarioCelularId) usuariosCelular.add(c.usuarioCelularId);
    for (const cx of c.caixas) {
      if (cx.tipo === 'historico') {
        caixasHistorico.add(cx.id);
        continue;
      }
      caixasRegua[cx.id] = c.slug;
      if (c.gerenteId) gerenteDaCaixa[cx.id] = c.gerenteId;
      if (c.metaAgendamentosDia) metaPorCaixa[cx.id] = c.metaAgendamentosDia;
      if (cx.tipo === 'cloud') {
        caixasCloud.add(cx.id);
        if (c.wabaId) caixasCapi[cx.id] = { slug: c.slug, waba: c.wabaId };
      }
      if (cx.tipo === 'evolution' && cx.instanciaEvolution) instanciaCaixa[cx.instanciaEvolution] = cx.id;
    }
  }
  configs = porSlug;
}

aplicarConfigs([SEMENTE_PARAUAPEBAS]);

// ── leitura ───────────────────────────────────────────────────────────────────────────────────────

export function configDaUnidade(slug: string): ConfigChatwootUnidade | undefined {
  return configs.get(slug);
}

export function unidadesConfiguradas(): ConfigChatwootUnidade[] {
  return [...configs.values()];
}

/** O usuário é um "📱 Celular da unidade" de alguma unidade? */
export function ehUsuarioCelular(id: number | null | undefined): boolean {
  return typeof id === 'number' && usuariosCelular.has(id);
}

/**
 * `doutor-hernia-parauapebas` → `PARAUAPEBAS` (o sufixo das variáveis do rastreio). Unidade com configuração usa o sufixo dela;
 * sem configuração, a regra de sempre (tira o "doutor-hernia-" do começo).
 */
export function sufixoEnvDaUnidade(slug: string): string {
  const c = configs.get(slug);
  if (c) return c.envSufixo;
  return slug.replace(/^doutor-hernia-/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/** Os `phone_number_id` do Kapso de todas as unidades configuradas (sem repetir). */
export function numerosDoKapsoConfigurados(): string[] {
  const l: string[] = [];
  for (const c of configs.values()) if (c.kapsoPhoneNumberId && !l.includes(c.kapsoPhoneNumberId)) l.push(c.kapsoPhoneNumberId);
  return l;
}

/** O nome do modelo na Meta: o nome base da régua (`parau_x`) com o prefixo da unidade. */
export const PREFIXO_BASE_DOS_MODELOS = 'parau_';
export function nomeDoModeloNaMeta(nomeBase: string, prefixoDaUnidade: string | undefined | null): string {
  if (!prefixoDaUnidade || prefixoDaUnidade === PREFIXO_BASE_DOS_MODELOS) return nomeBase;
  return nomeBase.startsWith(PREFIXO_BASE_DOS_MODELOS) ? prefixoDaUnidade + nomeBase.slice(PREFIXO_BASE_DOS_MODELOS.length) : nomeBase;
}

// ── do banco para a configuração (puro) ──────────────────────────────────────────────────────────

export type LinhaDoBanco = {
  unitId: string;
  prefixoModelos: string;
  usuarioCelularId: number | null;
  gerenteId: number | null;
  metaAgendamentosDia: number | null;
  kapsoPhoneNumberId: string | null;
  wabaId: string | null;
  envSufixo: string;
  dadosModelos: unknown;
  unit: { slug: string };
  caixas: Array<{ caixaId: number; tipo: string; instanciaEvolution: string | null }>;
};

export function configDaLinha(l: LinhaDoBanco): ConfigChatwootUnidade {
  const d = (l.dadosModelos && typeof l.dadosModelos === 'object' ? l.dadosModelos : {}) as Partial<DadosDosModelos>;
  return {
    slug: l.unit.slug,
    prefixoModelos: l.prefixoModelos,
    usuarioCelularId: l.usuarioCelularId,
    gerenteId: l.gerenteId,
    metaAgendamentosDia: l.metaAgendamentosDia,
    kapsoPhoneNumberId: l.kapsoPhoneNumberId,
    wabaId: l.wabaId,
    envSufixo: l.envSufixo,
    dadosModelos: {
      nome: String(d.nome ?? ''),
      cidade: String(d.cidade ?? ''),
      endereco: String(d.endereco ?? ''),
      mapa: String(d.mapa ?? ''),
      ...(d.telefone ? { telefone: String(d.telefone) } : {}),
      ...(d.valorConsulta ? { valorConsulta: String(d.valorConsulta) } : {}),
      ...(d.valorComSinal ? { valorComSinal: String(d.valorComSinal) } : {}),
    },
    caixas: l.caixas.map((x) => ({ id: x.caixaId, tipo: x.tipo as TipoDeCaixa, instanciaEvolution: x.instanciaEvolution })),
  };
}

/** A lista final: o que está no banco (válido) + a semente de Parauapebas se o banco não tem linha válida para ela. */
export function mesclarComSemente(doBanco: readonly ConfigChatwootUnidade[], aviso: (msg: string, slug: string) => void = () => {}): ConfigChatwootUnidade[] {
  const validas: ConfigChatwootUnidade[] = [];
  for (const c of doBanco) {
    const p = problemasDaConfig(c);
    if (p.length) aviso(`configuração ignorada: ${p.join('; ')}`, c.slug);
    else validas.push(c);
  }
  // a semente entra primeiro na checagem de conflito só se não houver linha válida para ela
  const lista = validas.some((c) => c.slug === SEMENTE_PARAUAPEBAS.slug) ? validas : [SEMENTE_PARAUAPEBAS, ...validas];
  const ruins = conflitosEntreUnidades(lista);
  for (const [slug, motivo] of ruins) aviso(`configuração ignorada: ${motivo}`, slug);
  return lista.filter((c) => !ruins.has(c.slug));
}

