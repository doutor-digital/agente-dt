/**
 * Origem e campanha no CONTATO do Chatwoot (`chatwoot-origem`; João, 13–14/11/2026: "eles vão preencher o campo automaticamente?
 * faça você mesmo") — o mesmo que o rastreio do Kommo faz no cartão. Refeito sobre o `kapso-referral` (o Chatwoot perde o código
 * do anúncio no caminho do Kapso; o servidor busca no Kapso).
 *
 * Quando uma mensagem de paciente comprovadamente veio de anúncio «Clique para o WhatsApp» (referral achado no Kapso):
 *   Origem = «Meta Ads» (opção da lista do Chatwoot) + Campanha e Conjunto de anúncios com os NOMES lidos na Meta pelo id do anúncio.
 * Regras (achados do sênior na 1ª versão, #324):
 *  - NUNCA marca «Orgânico» por dedução (sem referral não dá para saber: anúncio em Status não manda, Kapso pode falhar);
 *  - RELÊ o contato logo antes de gravar e só preenche campo VAZIO (o que a menina pôs à mão fica; duas mensagens seguidas não brigam);
 *  - origem manual diferente de «Meta Ads» → não mexe em campanha;
 *  - erro da Meta aparece no log (status/código, nunca o token).
 * SÓ NO PAPEL: não grava; loga «[SECO] preencheria…». Estado por unidade na tela de automações (CHATWOOT_ORIGEM_SLUGS).
 *
 * ORIGEM «FORMULÁRIO» (`chatwoot-formulario`; caso Capivari, 17/11/2026): o lead do formulário do site abre o WhatsApp com um TEXTO PRONTO
 * («Olá! Meu nome é X… Vim pelo formulário…») e chega SEM referral — o contato ficava sem origem. `preencherFormulario` reconhece o texto
 * numa das primeiras falas do paciente e grava Origem = «Formulário» + etiqueta `formulario`. Padrão por unidade em
 * `units.pipeline_intents.origem_por_texto` (as entradas cuja origem é «Formulário» — a MESMA lista que o Kommo já usa); sem lista, vale
 * «vim pelo formulário». Nunca sobrescreve origem que já existe (a de anúncio, a da equipe), e só grava se a opção «Formulário» existir na lista
 * de Origem da conta (senão o valor ficaria fora da lista, ilegível). É palpite pelo texto: o referral de anúncio, quando chega (inclusive depois, pelo script retroativo),
 * o SUBSTITUI por «Meta Ads» + campanha (`decidirOrigem`) e tira a etiqueta `formulario` (`aoAcharReferral`).
 * Estado por unidade: CHATWOOT_FORMULARIO_SLUGS. Padrão: DESLIGADO (Parauapebas idêntica); numa conta própria (clínica nova) o catálogo faz o padrão ser SECO, como nas outras `chatwoot-*`.
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { sufixoDaUnidade } from './chatwoot-gestor.js';
import type { ReferralDoKapso } from './kapso-referral.js';
import { casarFala, lerListaDeTextos, normalizarFrase, type EntradaDaLista } from './origem-texto-pronto.js';

export const ID_ORIGEM = 'chatwoot-origem';
export const ORIGEM_ANUNCIO = 'Meta Ads';
const GRAPH = `${process.env.META_GRAPH_URL || 'https://graph.facebook.com'}/${process.env.META_GRAPH_VERSION || 'v23.0'}`;

export interface NomesDoAnuncio {
  campanha: string | null;
  conjunto: string | null;
}
type Atual = { origem?: unknown; campanha_nome?: unknown; conjunto?: unknown; origem_palpite?: unknown };
/** Atributo OCULTO do contato (sem definição no Chatwoot, não aparece na tela): o robô o grava junto com «Formulário» para saber que a origem é palpite dele. */
export const ATRIBUTO_PALPITE = 'origem_palpite';
export const MARCA_PALPITE_FORMULARIO = 'formulario-texto';
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * «Formulário» do ROBÔ é um PALPITE pelo texto da mensagem (`preencherFormulario`), e palpite não vale mais que prova: com o referral do anúncio na mão a origem passa a
 * «Meta Ads» (e a campanha). Acontece quando o Kapso falhou na hora e o referral chegou depois (o script retroativo). Só o palpite do ROBÔ é trocado — o contato tem o
 * marcador oculto `origem_palpite` que o robô gravou junto. «Formulário» que a EQUIPE escolheu à mão (sem o marcador) e qualquer outra origem preenchida
 * («Indicação»…) continuam intocáveis.
 */
export const ehPalpiteDeFormulario = (atual: Atual): boolean => normalizarFrase(txt(atual.origem)) === normalizarFrase('Formulário') && txt(atual[ATRIBUTO_PALPITE]) === MARCA_PALPITE_FORMULARIO;

/** O que gravar no contato (só campos vazios, e «Formulário» no lugar do anúncio comprovado), ou null. Função pura. */
export function decidirOrigem(atual: Atual, nomes: NomesDoAnuncio | null): Record<string, string> | null {
  const grava: Record<string, string> = {};
  const origem = txt(atual.origem);
  const trocaOPalpite = ehPalpiteDeFormulario(atual);
  if (!origem || trocaOPalpite) grava.origem = ORIGEM_ANUNCIO;
  if (trocaOPalpite) grava[ATRIBUTO_PALPITE] = ''; // o palpite caiu: o marcador sai junto
  if ((origem || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO || trocaOPalpite) {
    if (!txt(atual.campanha_nome) && nomes?.campanha) grava.campanha_nome = nomes.campanha.slice(0, 200);
    if (!txt(atual.conjunto) && nomes?.conjunto) grava.conjunto = nomes.conjunto.slice(0, 200);
  }
  return Object.keys(grava).length ? grava : null;
}

type Buscar = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const cache = new Map<string, { ate: number; v: NomesDoAnuncio | null }>();
export function limparCacheDaOrigem(): void {
  cache.clear();
}

/** Nomes da campanha e do conjunto do anúncio (token só no cabeçalho; erro da Meta vai para o log). null = não deu. */
export async function nomesDoAnuncio(anuncio: string, token: string, buscar: Buscar = fetch as unknown as Buscar, agora: () => number = Date.now): Promise<NomesDoAnuncio | null> {
  const hit = cache.get(anuncio);
  if (hit && hit.ate > agora()) return hit.v;
  let v: NomesDoAnuncio | null = null;
  try {
    const r = await buscar(`${GRAPH}/${encodeURIComponent(anuncio)}?fields=campaign%7Bname%7D,adset%7Bname%7D`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await r.json().catch(() => null)) as { campaign?: { name?: unknown }; adset?: { name?: unknown }; error?: { code?: unknown } } | null;
    if (r.ok && j) v = { campanha: txt(j.campaign?.name) || null, conjunto: txt(j.adset?.name) || null };
    else logger.warn({ anuncio, status: r.status, codigo: j?.error?.code }, `${ID_ORIGEM}: a Meta recusou a leitura do anúncio`);
  } catch (err) {
    logger.warn({ anuncio, err: String(err).replace(token, '***') }, `${ID_ORIGEM}: não consegui ler o anúncio na Meta`);
  }
  cache.set(anuncio, { ate: agora() + (v ? 6 * 3_600_000 : 10 * 60_000), v });
  if (cache.size > 500) cache.clear();
  return v;
}

/** O token de anúncios da unidade (o mesmo do Marketing): META_ADS_TOKEN_<UNIDADE> ou units.meta_access_token. */
async function tokenDeAnuncios(slug: string): Promise<string | null> {
  const env = (process.env[`META_ADS_TOKEN_${sufixoDaUnidade(slug)}`] ?? '').trim();
  if (env) return env;
  const u = await prisma.unit.findUnique({ where: { slug }, select: { metaAccessToken: true } }).catch(() => null);
  return u?.metaAccessToken?.trim() || null;
}

export interface PortasDaOrigem {
  estado(slug: string): Estado;
  /** os campos do contato AGORA (relidos antes de gravar) */
  contato(contato: number): Promise<Atual>;
  nomes(slug: string, anuncio: string): Promise<NomesDoAnuncio | null>;
  gravar(contato: number, campos: Record<string, string>): Promise<void>;
}

export function portasDaOrigem(ctx: ContextoChatwoot): PortasDaOrigem {
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_ORIGEM, process.env.CHATWOOT_ORIGEM_SLUGS),
    async contato(contato) {
      const r = (await chamar(ctx, 'GET', `contacts/${contato}`)) as { payload?: { custom_attributes?: Atual }; custom_attributes?: Atual } | null;
      return r?.payload?.custom_attributes ?? r?.custom_attributes ?? {};
    },
    async nomes(slug, anuncio) {
      const token = await tokenDeAnuncios(slug);
      return token ? nomesDoAnuncio(anuncio, token) : null;
    },
    async gravar(contato, campos) {
      // o Chatwoot MESCLA custom_attributes no PUT do contato (contacts_controller#contact_custom_attributes)
      await chamar(ctx, 'PUT', `contacts/${contato}`, { corpo: { custom_attributes: campos } });
    },
  };
}

export const ETIQUETA_ANUNCIO = 'anuncio';

/**
 * Etiqueta «anuncio» na CONVERSA que comprovadamente veio de anúncio (João, 14/11/2026: "onde vejo essas conversas que veio de
 * anúncio?"). É informação, não ação: vale mesmo com `chatwoot-origem` desligada ou no papel. ACRESCENTA (relê as etiquetas e
 * manda a lista inteira; nunca tira as outras). Publicação impulsionada que não é anúncio (tipo «post») não ganha.
 * CHATWOOT_ETIQUETA_ANUNCIO=0 desliga. Não lança.
 */
export async function etiquetarAnuncio(
  conversa: number,
  ref: ReferralDoKapso,
  adicionar: (conversa: number, etiquetas: string[]) => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.CHATWOOT_ETIQUETA_ANUNCIO === '0' || ref.tipo !== 'ad') return false;
  try {
    await adicionar(conversa, [ETIQUETA_ANUNCIO]);
    return true;
  } catch (err) {
    logger.warn({ conversa, err: String(err) }, `${ID_ORIGEM}: não consegui pôr a etiqueta ${ETIQUETA_ANUNCIO}`);
    return false;
  }
}

/** Roda quando o servidor achou o referral de anúncio de uma mensagem. Não lança. */
export async function preencherOrigem(
  e: { slug: string; contato: number; conversa: number; ref: ReferralDoKapso },
  p: PortasDaOrigem,
): Promise<'desligado' | 'nada' | 'seco' | 'gravado' | 'trocou-palpite'> {
  try {
    const modo = p.estado(e.slug);
    if (modo === 'desligado') return 'desligado';
    if (e.ref.tipo !== 'ad') return 'nada'; // publicação (não anúncio): não chuta origem
    const antes = await p.contato(e.contato);
    const precisaNome = !!e.ref.anuncio && (!txt(antes.campanha_nome) || !txt(antes.conjunto)) && ((txt(antes.origem) || ORIGEM_ANUNCIO) === ORIGEM_ANUNCIO || ehPalpiteDeFormulario(antes));
    const nomes = precisaNome ? await p.nomes(e.slug, e.ref.anuncio!).catch(() => null) : null;
    // relê na hora de gravar: outra mensagem (ou a menina) pode ter preenchido enquanto a Meta respondia
    const agora = precisaNome ? await p.contato(e.contato) : antes;
    const grava = decidirOrigem(agora, nomes);
    if (!grava) return 'nada';
    if (modo === 'seco') {
      logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: [SECO] preencheria no contato ${e.contato}: ${JSON.stringify(grava)}`);
      return 'seco';
    }
    await p.gravar(e.contato, grava);
    logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato, grava }, `${ID_ORIGEM}: preenchido no contato ${e.contato}`);
    return ATRIBUTO_PALPITE in grava ? 'trocou-palpite' : 'gravado'; // 'trocou-palpite' = a origem era o palpite do formulário e virou anúncio
  } catch (err) {
    logger.warn({ slug: e.slug, contato: e.contato, err: String(err) }, `${ID_ORIGEM}: falhou`);
    return 'nada';
  }
}

// ── Origem «Formulário» (texto pronto do formulário do site) ──────────────────────────────────────

export const ID_FORMULARIO = 'chatwoot-formulario';
export const ORIGEM_FORMULARIO = 'Formulário';
export const ETIQUETA_FORMULARIO = 'formulario';
/** Só as primeiras falas do paciente valem: «vim pelo formulário» no meio de uma conversa antiga não é lead de formulário. */
export const FALAS_DO_FORMULARIO = 3;
/** O texto do formulário da GAC (Taubaté, Olímpia, Capivari, Boituva, Caxias): o começo muda a cada lead, o que identifica é «vim pelo formulário». */
export const PADRAO_DO_FORMULARIO: readonly EntradaDaLista[] = [
  { texto: 'vim pelo formulário', origem: ORIGEM_FORMULARIO, anuncio: false, contem: true, chave: normalizarFrase('vim pelo formulário') },
];

/** Os padrões da unidade: as entradas de `origem_por_texto` cuja origem é «Formulário»; sem nenhuma, o padrão de sempre. Puro. */
export function padroesDoFormulario(pipelineIntents: unknown, aviso: (motivo: string) => void = () => undefined): EntradaDaLista[] {
  const doCadastro = lerListaDeTextos(pipelineIntents, aviso).filter((e) => normalizarFrase(e.origem) === normalizarFrase(ORIGEM_FORMULARIO));
  return doCadastro.length ? doCadastro : [...PADRAO_DO_FORMULARIO];
}

export type PortasDoFormulario = Pick<PortasDaOrigem, 'contato' | 'gravar'> & {
  estado(slug: string): Estado;
  /** o estado de `chatwoot-origem` (o tratamento do anúncio): o palpite só roda com ele LIGADO — é ele que troca o palpite pelo referral; sem ele o «Formulário» ficaria para sempre */
  estadoOrigem(slug: string): Estado;
  /** os padrões da unidade (cadastro ou o de sempre) */
  padroes(slug: string): Promise<EntradaDaLista[]>;
  /** as opções da lista «Origem» da conta; null = não deu para ler */
  opcoesDaOrigem(): Promise<string[] | null>;
  /** quantas falas de paciente a conversa já tem (as 20 últimas); a posição da fala no começo da conversa */
  falasDoPaciente(conversa: number): Promise<string[] | null>;
  etiquetar(conversa: number, etiquetas: string[]): Promise<void>;
};

const cacheDosPadroes = new Map<string, { ate: number; v: EntradaDaLista[] }>();
const cacheDasOpcoes = new Map<number, { ate: number; v: string[] }>();
/** conversa → até quando já foi decidida (gravou, seco, sem a opção): as 3 primeiras falas não refazem as leituras nem repetem o log */
const decididas = new Map<string, number>();
const TETO_DAS_DECISOES = 2000;
/** anota a decisão da conversa; o mapa tem teto (limpa o vencido e, se ainda passar, tudo) — nunca cresce sem fim */
function decidir(chave: string, ms: number): void {
  if (decididas.size >= TETO_DAS_DECISOES) {
    const agora = Date.now();
    for (const [k, ate] of decididas) if (ate <= agora) decididas.delete(k);
    if (decididas.size >= TETO_DAS_DECISOES) decididas.clear();
  }
  decididas.set(chave, Date.now() + ms);
}
const VALIDADE_DA_DECISAO_MS = 30 * 60_000;
/** só para teste: quantas conversas estão decididas agora */
export const tamanhoDasDecisoes = (): number => decididas.size;
export function limparCacheDoFormulario(): void {
  cacheDosPadroes.clear();
  cacheDasOpcoes.clear();
  decididas.clear();
}

export function portasDoFormulario(ctx: ContextoChatwoot, origem: PortasDaOrigem, adicionarEtiquetas: (conversa: number, etiquetas: string[]) => Promise<void>): PortasDoFormulario {
  return {
    contato: origem.contato,
    gravar: origem.gravar,
    estado: (slug) => estadoDaAutomacao(slug, ID_FORMULARIO, process.env.CHATWOOT_FORMULARIO_SLUGS),
    estadoOrigem: (slug) => estadoDaAutomacao(slug, ID_ORIGEM, process.env.CHATWOOT_ORIGEM_SLUGS),
    async padroes(slug) {
      const hit = cacheDosPadroes.get(slug);
      if (hit && hit.ate > Date.now()) return hit.v;
      let u: { pipelineIntents: unknown } | null;
      try {
        u = await prisma.unit.findUnique({ where: { slug }, select: { pipelineIntents: true } });
      } catch (err) {
        // erro do banco NÃO fica em cache: vale o padrão desta vez e a próxima fala lê de novo (senão o padrão da unidade sumiria por 10 min)
        logger.warn({ slug, err: String(err) }, `${ID_FORMULARIO}: não consegui ler os padrões da unidade — uso o padrão de sempre desta vez`);
        return padroesDoFormulario(null);
      }
      const v = padroesDoFormulario(u?.pipelineIntents, (motivo) => logger.warn({ slug }, `${ID_FORMULARIO}: ${motivo}`));
      cacheDosPadroes.set(slug, { ate: Date.now() + 10 * 60_000, v });
      return v;
    },
    async opcoesDaOrigem() {
      const conta = ctx.conta?.conta;
      const hit = conta ? cacheDasOpcoes.get(conta) : undefined;
      if (hit && hit.ate > Date.now()) return hit.v;
      try {
        const r = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'contact_attribute' } })) as unknown;
        const lista = Array.isArray(r) ? r : ((r as { payload?: unknown } | null)?.payload as unknown[] | undefined) ?? [];
        const d = (lista as Array<{ attribute_key?: unknown; attribute_values?: unknown }>).find((x) => x?.attribute_key === 'origem');
        const v = d && Array.isArray(d.attribute_values) ? d.attribute_values.map(String) : null;
        if (v && conta) cacheDasOpcoes.set(conta, { ate: Date.now() + 5 * 60_000, v }); // erro e «sem a lista» NÃO ficam em cache: a próxima fala lê de novo
        return v;
      } catch (err) {
        logger.warn({ err: String(err) }, `${ID_FORMULARIO}: não consegui ler a lista de Origem da conta`);
        return null;
      }
    },
    async falasDoPaciente(conversa) {
      const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`)) as { payload?: Array<{ message_type?: unknown; private?: unknown; content?: unknown }> } | null;
      const l = r?.payload;
      if (!Array.isArray(l)) return null;
      // o Chatwoot devolve as 20 últimas: com 20 ou mais mensagens a conversa não está no começo
      if (l.length >= 20) return null;
      return l.filter((m) => (m.message_type === 0 || m.message_type === 'incoming') && m.private !== true).map((m) => String(m.content ?? ''));
    },
    etiquetar: adicionarEtiquetas,
  };
}

/** Webhook do Chatwoot → fala de PACIENTE com texto, numa caixa de unidade; ou null. Qualquer tipo de caixa (oficial, Lite): o texto pronto chega por todas. */
export function falaParaFormulario(corpo: any, caixas: Readonly<Record<number, string>>): { slug: string; conversa: number; contato: number | null; texto: string } | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0) || corpo?.private === true) return null;
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const conversa = Number(corpo?.conversation?.id);
  const slug = caixas[caixa];
  const texto = typeof corpo?.content === 'string' ? corpo.content.slice(0, 2000) : '';
  if (!slug || !Number.isInteger(conversa) || conversa <= 0 || !texto.trim()) return null;
  const contato = Number(corpo?.sender?.id);
  return { slug, conversa, contato: Number.isInteger(contato) && contato > 0 ? contato : null, texto };
}

export type ResultadoDoFormulario = 'desligado' | 'origem-desligada' | 'nada' | 'seco' | 'gravado' | 'sem-opcao';

/**
 * Roda a cada fala de paciente. Barato quando não casa (só o estado e a comparação do texto). Não lança.
 * Só campo VAZIO: origem que já existe (anúncio, equipe) nunca é trocada; relê o contato imediatamente antes de gravar.
 */
export async function preencherFormulario(
  e: { slug: string; contato: number | null; conversa: number; texto: string },
  p: PortasDoFormulario,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResultadoDoFormulario> {
  try {
    if (env.CHATWOOT_FORMULARIO === '0') return 'desligado';
    const modo = p.estado(e.slug);
    if (modo === 'desligado' || !e.contato) return 'desligado';
    // sem `chatwoot-origem` LIGADO o referral de anúncio não grava origem: o palpite ficaria para sempre e ainda bloquearia o anúncio. Não roda (nem lê nada).
    if (p.estadoOrigem(e.slug) !== 'ligado') return 'origem-desligada';
    const padroes = await p.padroes(e.slug);
    if (!casarFala(e.texto, padroes)) return 'nada';
    const chave = `${e.slug}:${e.conversa}`;
    if ((decididas.get(chave) ?? 0) > Date.now()) return 'nada'; // já decidida nesta conversa (as 3 primeiras falas não repetem leitura nem log)
    // posição: o texto pronto é uma das primeiras falas; conversa que não dá para ler (ou já longa) não ganha origem de palpite
    const falas = await p.falasDoPaciente(e.conversa);
    if (!falas || !falas.slice(0, FALAS_DO_FORMULARIO).some((f) => casarFala(f, padroes))) return 'nada';
    const antes = await p.contato(e.contato);
    if (txt(antes.origem)) return 'nada'; // já tem origem (anúncio, equipe, ou o próprio «Formulário»): nunca troca
    const opcoes = await p.opcoesDaOrigem();
    // a opção como a LISTA da conta a escreve («Formulário», «formulario»…): grava o texto exato dela, nunca o nosso
    const opcao = opcoes?.find((o) => normalizarFrase(o) === normalizarFrase(ORIGEM_FORMULARIO));
    if (!opcao) {
      // no SECO não há o que avisar como problema: diz o que NÃO gravaria (info); no ligado é falha de configuração (warn)
      const dizer = modo === 'seco' ? logger.info.bind(logger) : logger.warn.bind(logger);
      const marca = modo === 'seco' ? '[SECO] ' : '';
      if (opcoes === null) dizer({ slug: e.slug, conversa: e.conversa }, `${ID_FORMULARIO}: ${marca}não consegui ler a lista de Origem da conta agora — não gravaria; a próxima fala tenta de novo`);
      else {
        dizer({ slug: e.slug, conversa: e.conversa }, `${ID_FORMULARIO}: ${marca}a lista de Origem da conta não tem a opção «${ORIGEM_FORMULARIO}» — não grava (adicione a opção em Configurações > Atributos personalizados)`);
        decidir(chave, 10 * 60_000);
      }
      return 'sem-opcao';
    }
    decidir(chave, VALIDADE_DA_DECISAO_MS);
    if (modo === 'seco') {
      logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato }, `${ID_FORMULARIO}: [SECO] preencheria Origem = ${ORIGEM_FORMULARIO} + etiqueta ${ETIQUETA_FORMULARIO} no contato ${e.contato}`);
      return 'seco';
    }
    // relê na hora de gravar: o referral de anúncio ou a equipe podem ter preenchido enquanto líamos a conversa
    if (txt((await p.contato(e.contato)).origem)) return 'nada';
    // (a releitura e o PUT não são uma operação só — o Chatwoot não tem «grava se vazio» —, mas a janela é de milissegundos e o anúncio é chamado ANTES deste, em fila)
    await p.gravar(e.contato, { origem: opcao, [ATRIBUTO_PALPITE]: MARCA_PALPITE_FORMULARIO }); // o marcador oculto diz que esta origem é palpite do robô (só ela o anúncio troca)
    await p.etiquetar(e.conversa, [ETIQUETA_FORMULARIO]).catch((err: unknown) => logger.warn({ conversa: e.conversa, err: String(err) }, `${ID_FORMULARIO}: não consegui pôr a etiqueta ${ETIQUETA_FORMULARIO}`));
    logger.info({ slug: e.slug, conversa: e.conversa, contato: e.contato }, `${ID_FORMULARIO}: Origem = ${ORIGEM_FORMULARIO} no contato ${e.contato}`);
    return 'gravado';
  } catch (err) {
    decididas.delete(`${e.slug}:${e.conversa}`); // falhou: a próxima fala tenta de novo
    logger.warn({ slug: e.slug, contato: e.contato, err: String(err) }, `${ID_FORMULARIO}: falhou`);
    return 'nada';
  }
}
