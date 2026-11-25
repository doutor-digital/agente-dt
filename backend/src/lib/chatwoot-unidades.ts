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
  /**
   * Conta do Chatwoot da unidade (1 conta por clínica vendida). `null` = a conta do ambiente (`CHATWOOT_CONTA_ID`, a 1): Parauapebas e qualquer
   * unidade que ainda mora na conta de sempre. A URL e o token são os mesmos para todas; só o id da conta muda.
   */
  contaId: number | null;
  /** subdomínio do CRM da clínica (<sub>.doutordigitalconsultoria.com); null/ausente = só a origem principal do Chatwoot */
  subdominio?: string | null;
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
  contaId: null,
  // este endereço já existe e a equipe pode estar usando: a origem dele é aceita pelas telas por iframe (migration 20261115150000 grava o mesmo no banco, só se estiver nulo)
  subdominio: 'drherniaparauapebas',
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
  if (c.contaId !== null && c.contaId !== undefined && (!Number.isInteger(c.contaId) || c.contaId <= 0)) p.push(`conta do Chatwoot inválida (${String(c.contaId)})`);
  if (c.subdominio !== null && c.subdominio !== undefined && !/^[a-z0-9]{3,40}$/.test(c.subdominio)) p.push(`subdomínio inválido (${String(c.subdominio)})`);
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

/**
 * Problemas ENTRE unidades: a mesma caixa ou o mesmo prefixo em duas unidades. Vale a ORDEM da lista (quem vem antes fica; quem vem
 * depois é descartado) e unidade descartada não segura caixa nem prefixo de ninguém. Devolve slug → motivo dos descartados.
 */
export function conflitosEntreUnidades(lista: readonly ConfigChatwootUnidade[]): Map<string, string> {
  const ruins = new Map<string, string>();
  const caixaDe = new Map<number, string>();
  const prefixoDe = new Map<string, string>();
  for (const c of lista) {
    let motivo: string | null = null;
    for (const cx of c.caixas) {
      const dono = caixaDe.get(cx.id);
      if (dono && dono !== c.slug) {
        motivo = `a caixa ${cx.id} já é de ${dono}`;
        break;
      }
    }
    const donoDoPrefixo = prefixoDe.get(c.prefixoModelos);
    if (!motivo && donoDoPrefixo && donoDoPrefixo !== c.slug) motivo = `o prefixo ${c.prefixoModelos} já é de ${donoDoPrefixo}`;
    if (motivo) {
      ruins.set(c.slug, motivo);
      continue; // descartada: não reserva caixa nem prefixo
    }
    for (const cx of c.caixas) caixaDe.set(cx.id, c.slug);
    prefixoDe.set(c.prefixoModelos, c.slug);
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
/** caixa → unidade dona (TODAS as caixas, inclusive as de histórico): quem diz de que conta é a caixa. */
const donoDaCaixa: Record<number, string> = {};

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
  esvaziar(donoDaCaixa);
  caixasCloud.clear();
  caixasHistorico.clear();
  usuariosCelular.clear();
  const porSlug = new Map<string, ConfigChatwootUnidade>();
  for (const c of lista) {
    porSlug.set(c.slug, c);
    if (c.usuarioCelularId) usuariosCelular.add(c.usuarioCelularId);
    for (const cx of c.caixas) {
      donoDaCaixa[cx.id] = c.slug;
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

/**
 * A conta do Chatwoot da unidade. TRÊS respostas, e a diferença importa:
 *  - um número: a conta própria da unidade;
 *  - `null`: a unidade existe e mora na conta do AMBIENTE (`CHATWOOT_CONTA_ID`, a 1) — Parauapebas;
 *  - `undefined`: unidade DESCONHECIDA (ou cuja configuração foi descartada por `conta_id` inválido, caixa ou prefixo repetido). Quem recebe
 *    `undefined` RECUSA e não chama o Chatwoot: tratar como «conta do ambiente» faria a escrita de uma clínica cair na conta de outra.
 */
export function contaDaUnidade(slug: string): number | null | undefined {
  const c = configs.get(slug);
  if (!c) return undefined;
  if (c.contaId === null || c.contaId === undefined) return null;
  return Number.isInteger(c.contaId) && c.contaId > 0 ? c.contaId : undefined; // conta_id inválido nunca vira «conta do ambiente»
}

/** A unidade dona da caixa (qualquer tipo, inclusive histórico), ou `undefined`. */
export function unidadeDaCaixa(caixa: number): string | undefined {
  return donoDaCaixa[caixa];
}

/** A conta da CAIXA (pela unidade dona): número, `null` = a do ambiente, `undefined` = caixa que nenhuma unidade configurada tem (recusar). */
export function contaDaCaixa(caixa: number): number | null | undefined {
  const slug = donoDaCaixa[caixa];
  return slug ? contaDaUnidade(slug) : undefined;
}

/**
 * As contas EXPLÍCITAS (as que têm unidade apontando para elas), sem repetir. Quem precisa da lista completa soma a do ambiente
 * (`contaChatwootDoAmbiente`): `contasDoChatwoot` em `mcp-remoto/chatwoot.ts`.
 */
export function contasExplicitas(): number[] {
  const l: number[] = [];
  for (const c of configs.values()) if (c.contaId && !l.includes(c.contaId)) l.push(c.contaId);
  return l;
}

/**
 * As caixas das unidades que moram na conta `contaId` (`contaDoAmbiente` = o número da conta do ambiente, que é a das unidades sem conta
 * própria). Serve a quem guarda dado por (caixa, conversa): o id da conversa é POR CONTA, a caixa é única na instalação.
 */
export function caixasDaConta(contaId: number, contaDoAmbiente: number | null): number[] {
  const l: number[] = [];
  for (const c of configs.values()) if ((c.contaId ?? contaDoAmbiente) === contaId) for (const x of c.caixas) if (!l.includes(x.id)) l.push(x.id);
  return l;
}

/** As caixas das unidades que NÃO moram na conta do ambiente (de contas próprias). */
export function caixasDeContasProprias(): number[] {
  const l: number[] = [];
  for (const c of configs.values()) if (c.contaId) for (const x of c.caixas) if (!l.includes(x.id)) l.push(x.id);
  return l;
}

/** O domínio dos CRMs das clínicas: <subdominio>.doutordigitalconsultoria.com. */
export const DOMINIO_DOS_CRMS = 'doutordigitalconsultoria.com';

/** Subdomínio aceito: o mesmo formato de `problemasDaConfig` (minúsculas e dígitos), nunca algo que vire caminho, porta ou outro host. */
export const subdominioValido = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{3,40}$/.test(s);

/**
 * TODA linha de `unit_chatwoot` com subdomínio, MESMO a que ainda não vale como configuração (sem caixa = inerte: os workers a ignoram, e continuam ignorando).
 * O endereço da clínica existe desde o dia em que a conta foi criada (Timbó, conta 3, 25/11/2026): as telas por iframe têm de aceitar a origem dele
 * (o `menu.js` também precisará da conta dele: outro PR). Só leitura de endereço; não entra em `configDaUnidade` nem em nenhum mapa de caixa.
 */
let dominiosDasLinhas: ReadonlyArray<{ subdominio: string; contaId: number | null }> = [];
export function aplicarDominios(linhas: ReadonlyArray<{ subdominio?: string | null; contaId?: number | null }>): void {
  // todas as linhas, repetidas inclusive: o mapa decide o que é ambíguo
  dominiosDasLinhas = linhas.filter((l) => subdominioValido(l.subdominio)).map((l) => ({ subdominio: l.subdominio as string, contaId: Number.isInteger(l.contaId) && (l.contaId as number) > 0 ? (l.contaId as number) : null }));
}

/**
 * subdomínio → conta, das clínicas válidas E das inertes (o `menu.js` leva só isto: subdomínio e número). Conta nula = a do ambiente (`contaDoAmbiente`) SÓ para a
 * configuração válida (Parauapebas, que mora na conta do ambiente); uma linha crua sem conta própria NUNCA é atribuída à conta do ambiente (ficaria com os dados de
 * outra clínica). Subdomínio repetido com contas diferentes é ambíguo: fica de fora.
 */
export function dominiosDasClinicas(contaDoAmbiente: number | null): Record<string, number> {
  const contas = new Map<string, Set<number>>();
  // `comAmbiente`: só a configuração VÁLIDA usa «conta nula = a do ambiente» (é a regra da semente de Parauapebas); linha crua sem conta própria fica de fora
  const pôr = (sub: string | null | undefined, conta: number | null | undefined, comAmbiente: boolean): void => {
    if (!subdominioValido(sub)) return;
    const c = conta ?? (comAmbiente ? contaDoAmbiente : null);
    if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0) return;
    contas.set(sub, (contas.get(sub) ?? new Set<number>()).add(c));
  };
  for (const c of dominiosDasLinhas) pôr(c.subdominio, c.contaId, false);
  for (const c of configs.values()) pôr(c.subdominio, c.contaId, true);
  const m: Record<string, number> = {};
  // o mesmo subdomínio com contas diferentes (linhas ou configurações) é ambíguo: fica de fora, nunca decide pela ordem
  for (const [sub, set] of contas) if (set.size === 1) m[sub] = [...set][0]!;
  return m;
}

/** As origens https dos CRMs das clínicas CADASTRADAS (subdomínio gravado em `unit_chatwoot`, com ou sem caixa). Quem não tem subdomínio não entra. */
export function origensDasClinicas(): string[] {
  const subs = new Set<string>([...configs.values()].map((c) => c.subdominio).filter(subdominioValido));
  for (const d of dominiosDasLinhas) subs.add(d.subdominio);
  return [...subs].map((s) => `https://${s}.${DOMINIO_DOS_CRMS}`).sort();
}

/** As unidades SEM conta própria (as da conta do ambiente), em ordem alfabética. */
export function unidadesSemConta(): string[] {
  return [...configs.values()].filter((c) => c.contaId === null || c.contaId === undefined).map((c) => c.slug).sort();
}

/** As unidades que moram na conta própria `contaId`, em ordem ALFABÉTICA do slug (a mesma em toda chamada: quem pega a primeira pega sempre a mesma). */
export function unidadesDaConta(contaId: number): string[] {
  return [...configs.values()].filter((c) => c.contaId === contaId).map((c) => c.slug).sort();
}

/**
 * O usuário é o "📱 Celular da unidade" DESTA unidade? Cada clínica tem o seu usuário (na conta dela): o do celular de uma não é «celular» na
 * conversa de outra, mesmo que alguém configure o mesmo id nas duas por engano. Unidade desconhecida: nunca é celular.
 */
export function ehUsuarioCelular(id: number | null | undefined, slug: string): boolean {
  const u = configs.get(slug)?.usuarioCelularId;
  return typeof id === 'number' && typeof u === 'number' && u === id;
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

/** Dos números das unidades configuradas, os que NÃO estão na lista dada (a variável de ambiente que manda sobre a configuração). */
export function numerosForaDaLista(lista: readonly string[]): string[] {
  return numerosDoKapsoConfigurados().filter((n) => !lista.includes(n));
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
  /** coluna nova (passo 1): linha lida antes dela existir vem sem o campo */
  contaId?: number | null;
  subdominio?: string | null;
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
    contaId: l.contaId ?? null,
    subdominio: l.subdominio ?? null,
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

/**
 * As linhas cujo ENDEREÇO entra nas origens aceitas além das configurações vivas: só a INERTE (o ÚNICO problema é «sem nenhuma caixa» — a clínica já existe, falta ligar o canal)
 * e que não colide com ninguém: o prefixo dos modelos não pode ser de OUTRA unidade viva (nem de outra inerte que veio antes, por slug) — a mesma regra que descarta uma
 * configuração em `mesclarComSemente`. Linha VÁLIDA mas descartada por conflito (prefixo ou caixa repetidos) NÃO entra: o sistema a ignorou, não é origem confiável.
 * Quem já está viva (`vivas`) entra pelas configurações, não por aqui.
 */
export function linhasInertasSemConflito(linhas: readonly LinhaDoBanco[], vivas: readonly ConfigChatwootUnidade[]): LinhaDoBanco[] {
  const vivasPorSlug = new Set(vivas.map((c) => c.slug));
  const prefixoDe = new Map<string, string>(vivas.map((c) => [c.prefixoModelos, c.slug]));
  const inertas = linhas
    .map((l) => ({ l, c: configDaLinha(l) }))
    .filter(({ c }) => {
      const p = problemasDaConfig(c);
      return p.length > 0 && p.every((m) => m === 'sem nenhuma caixa') && !vivasPorSlug.has(c.slug);
    })
    .sort((a, b) => (a.c.slug < b.c.slug ? -1 : a.c.slug > b.c.slug ? 1 : 0));
  const aceitas: LinhaDoBanco[] = [];
  for (const { l, c } of inertas) {
    const dono = prefixoDe.get(c.prefixoModelos);
    if (dono && dono !== c.slug) continue; // o prefixo já é de outra unidade
    prefixoDe.set(c.prefixoModelos, c.slug);
    aceitas.push(l);
  }
  return aceitas;
}

/** A lista final: o que está no banco (válido) + a semente de Parauapebas se o banco não tem linha válida para ela. */
export function mesclarComSemente(doBanco: readonly ConfigChatwootUnidade[], aviso: (msg: string, slug: string) => void = () => {}): ConfigChatwootUnidade[] {
  const validas: ConfigChatwootUnidade[] = [];
  for (const c of doBanco) {
    const p = problemasDaConfig(c);
    if (p.length) aviso(`configuração ignorada: ${p.join('; ')}`, c.slug);
    else validas.push(c);
  }
  // ORDEM FIXA (o `findMany` não tem ordem): Parauapebas primeiro (a linha do banco, se for válida; senão a semente), depois as outras por slug.
  // Assim uma linha nova nunca derruba a unidade que já está no ar por causa de um conflito de caixa ou de prefixo.
  const propria = validas.find((c) => c.slug === SEMENTE_PARAUAPEBAS.slug) ?? SEMENTE_PARAUAPEBAS;
  const outras = validas.filter((c) => c.slug !== SEMENTE_PARAUAPEBAS.slug).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const lista = [propria, ...outras];
  const ruins = conflitosEntreUnidades(lista);
  for (const [slug, motivo] of ruins) aviso(`configuração ignorada: ${motivo}`, slug);
  return lista.filter((c) => !ruins.has(c.slug));
}

