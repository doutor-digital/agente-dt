/**
 * OS PASSOS DE FORA DO BANCO do `--aplicar` (kit de unidade, fase 2): a conta do Chatwoot da clínica (API de plataforma), o que vai dentro dela
 * (etiquetas, atributos, automações, mensagens prontas, caixa, time, atendentes, robô, webhook, aba do Funil) e os modelos na Meta via Kapso.
 *
 * Cada passo é IDEMPOTENTE POR LEITURA: lê o que a conta já tem e só cria o que falta (o Chatwoot recusa nome repetido com 422; aqui nem se tenta).
 * A conta de REFERÊNCIA (Parauapebas, a conta do ambiente) só é lida: etiquetas, atributos e automações da conta nova nascem do molde dela.
 * Segredo gerado (token do usuário conector, token do robô) vai direto para o cofre (`SegredosPorta`) e nunca para o texto que sai daqui.
 */
import { chaveDoEvento } from '../chatwoot-ia.js';
import { comDadosDaUnidade, modelosDaUnidade } from '../chatwoot-modelos.js';
import { ATRIBUTOS_DE_CONTATO, ATRIBUTOS_DE_CONVERSA, ETIQUETAS_DO_CODIGO, LISTAS_EDITAVEIS, MENSAGENS_PRONTAS } from './catalogo.js';
import { ErroDaPorta, ErroSoLeitura, type ContaPorta, type PortasExternas } from './portas.js';
import { configChatwootDoQuestionario, mascararEmails, sufixoDoQuestionario, type Questionario } from './questionario.js';

/** O que um passo deixa para os seguintes (só em memória, nunca impresso). */
export interface EstadoDaExecucao {
  contaId?: number;
  /** o token do usuário conector — vive só na memória desta execução (e no cofre) */
  tokenDaConta?: string;
  conta?: ContaPorta;
  caixaId?: number;
  timeId?: number;
  /** e-mail em minúsculas → id do agente na conta */
  agentes: Map<string, number>;
  celularId?: number;
  botId?: number;
  /** o passo foi tentado só LENDO (o plano dizia «nada»): qualquer escrita lança `ErroSoLeitura` e o executor pergunta e roda de novo */
  somenteLeitura?: boolean;
}

export const novoEstado = (): EstadoDaExecucao => ({ agentes: new Map() });

const lc = (s: string) => s.toLowerCase();
export const nomeDoSegredoDaConta = (q: Questionario) => `CHATWOOT_API_TOKEN_${sufixoDoQuestionario(q)}`;
export const nomeDoSegredoDoRobo = (q: Questionario) => `CHATWOOT_SOFIA_BOT_TOKEN_${sufixoDoQuestionario(q)}`;
/** o id (não secreto) do usuário conector: permite refazer o vínculo com a conta se ele falhou depois de o usuário nascer */
export const nomeDoSegredoDoUsuario = (q: Questionario) => `CHATWOOT_CONECTOR_USUARIO_${sufixoDoQuestionario(q)}`;
export const EMAIL_DO_CONECTOR = (q: Questionario) => `conector+${q.unidade.slug}@doutordigitalconsultoria.com`;

/** `[…]` ou `{payload:[…]}` ou `{payload:{<chave>:[…]}}` → a lista. */
export function listaDaResposta(r: unknown, chave?: string): any[] {
  if (Array.isArray(r)) return r;
  const p = (r as { payload?: unknown } | null)?.payload;
  if (Array.isArray(p)) return p;
  if (chave && p && typeof p === 'object' && Array.isArray((p as Record<string, unknown>)[chave])) return (p as Record<string, any[]>)[chave]!;
  return [];
}

function precisa<T>(v: T | null | undefined, porque: string): T {
  if (v === null || v === undefined) throw new ErroDaPorta(porque);
  return v;
}
/** POST na conta — a única porta de escrita dos passos de dentro da conta: no modo só-leitura lança em vez de escrever. */
function postar(e: EstadoDaExecucao, conta: ContaPorta, caminho: string, corpo?: Record<string, unknown>): Promise<unknown> {
  if (e.somenteLeitura) throw new ErroSoLeitura(`POST ${caminho}`);
  return conta.post(caminho, corpo);
}
/** PATCH na conta (mesma regra de `postar`: no modo só-leitura lança em vez de escrever). */
function corrigir(e: EstadoDaExecucao, conta: ContaPorta, caminho: string, corpo: Record<string, unknown>): Promise<unknown> {
  if (e.somenteLeitura) throw new ErroSoLeitura(`PATCH ${caminho}`);
  return conta.patch(caminho, corpo);
}
const daConta = (e: EstadoDaExecucao): ContaPorta => precisa(e.conta, 'a conta da clínica no Chatwoot ainda não está pronta (passo «conta»)');

// ── 1. a conta ───────────────────────────────────────────────────────────────────────────────────────

export interface DoBancoParaAConta {
  /** `unit_chatwoot.conta_id` hoje */
  contaId: number | null;
  /** caixas já registradas para a unidade (em qualquer conta): quem já atende pacientes numa conta não ganha uma conta nova vazia */
  caixasRegistradas: number[];
  /** grava o id da conta NA HORA em que ela nasce (antes de qualquer outra coisa): sem isto uma queda deixaria uma conta órfã e a próxima rodada criaria outra */
  gravarContaId(id: number): Promise<void>;
}

export async function passoConta(q: Questionario, x: PortasExternas, estado: EstadoDaExecucao, banco: DoBancoParaAConta): Promise<string[]> {
  const nomeToken = nomeDoSegredoDaConta(q);
  const nomeUsuario = nomeDoSegredoDoUsuario(q);
  const notas: string[] = [];
  let contaId = banco.contaId;
  // PROTEÇÃO DA CONTA DO AMBIENTE (Parauapebas): nunca criar conta nova para unidade que já está em uso lá, nem apontar uma clínica para a conta 1.
  // Com --sobrescrever isto não muda: criar conta e trocar o conta_id levaria a unidade inteira (caixas, conversas, régua) para uma conta vazia.
  if (contaId !== null && x.contaDoAmbiente !== null && contaId === x.contaDoAmbiente) {
    throw new ErroDaPorta(`o conta_id gravado (${contaId}) é o da conta do ambiente (CHATWOOT_CONTA_ID): o kit não monta clínica nessa conta`);
  }
  if (contaId === null && banco.caixasRegistradas.length > 0) {
    throw new ErroDaPorta(`a unidade já tem ${banco.caixasRegistradas.length} caixa(s) registrada(s) na conta do ambiente (já está em uso): criar uma conta nova e mudar o conta_id levaria tudo para uma conta vazia — o kit recusa, mesmo com --sobrescrever`);
  }
  if (contaId !== null) {
    if (x.plataforma && !(await x.plataforma.contaExiste(contaId))) throw new ErroDaPorta(`a conta ${contaId} (gravada no banco) não existe mais no Chatwoot: confira antes de criar outra`);
    notas.push(`conta ${contaId} já existia`);
  } else {
    if (estado.somenteLeitura) throw new ErroSoLeitura('criar a conta');
    const plataforma = precisa(x.plataforma, 'sem o token do Platform App (CHATWOOT_PLATFORM_TOKEN) não dá para criar a conta: o João roda ops/kit-unidade/criar-platform-app-joao.sh');
    // o Chatwoot entrega o token do usuário conector UMA vez: antes de criar qualquer coisa, o cofre precisa ter onde guardá-lo
    await x.segredos.pronto();
    // antes de criar: o cofre não pode já ter um token para esta clínica (seria de uma conta que o banco esqueceu)
    if (await x.segredos.tem(nomeToken)) throw new ErroDaPorta(`já existe ${nomeToken} no cofre/ambiente mas o banco não conhece a conta: confira antes de criar outra conta`);
    contaId = (await plataforma.criarConta(q.unidade.nome)).id;
    await banco.gravarContaId(contaId);
    notas.push(`conta ${contaId} criada e gravada em unit_chatwoot.conta_id`);
  }
  estado.contaId = contaId;
  let token = await x.segredos.ler(nomeToken);
  if (!token) {
    if (estado.somenteLeitura) throw new ErroSoLeitura('criar o usuário conector');
    const plataforma = precisa(x.plataforma, `a conta ${contaId} existe mas ${nomeToken} não está no cofre nem no ambiente, e sem o Platform App não dá para criar outro conector`);
    await x.segredos.pronto();
    const u = await plataforma.criarUsuario({ nome: `Conector ${q.unidade.slug}`, email: EMAIL_DO_CONECTOR(q), senha: x.gerarSenha() });
    // token e id do usuário vão para o cofre ANTES de qualquer outra coisa: o token só é entregue esta vez, e o id permite refazer o vínculo se ele falhar
    await x.segredos.guardar(nomeToken, u.tokenDeAcesso);
    await x.segredos.guardar(nomeUsuario, String(u.id));
    await plataforma.vincular(contaId, u.id, 'administrator');
    token = u.tokenDeAcesso;
    notas.push(`usuário conector ${u.id} criado como administrador; token guardado no cofre como ${nomeToken} (valor não impresso)`);
  } else notas.push(`${nomeToken} já está no cofre/ambiente`);
  estado.tokenDaConta = token;
  estado.conta = x.abrirConta(contaId, token);
  // o token tem acesso à conta? (o vínculo do conector pode ter falhado numa rodada anterior)
  try {
    await estado.conta.get('labels');
  } catch (err) {
    if ((err as { status?: number }).status !== 401 && (err as { status?: number }).status !== 403) throw err;
    if (estado.somenteLeitura) throw new ErroSoLeitura('refazer o vínculo do conector');
    const guardado = await x.segredos.ler(nomeUsuario);
    const plataforma = x.plataforma;
    if (!plataforma || !guardado || !/^\d+$/.test(guardado)) {
      throw new ErroDaPorta(`o token ${nomeToken} não tem acesso à conta ${contaId} (o vínculo do conector não chegou a ser feito) e não há como refazê-lo daqui: no Super Admin do Chatwoot, ponha o usuário conector como administrador da conta ${contaId}`);
    }
    await plataforma.vincular(contaId, Number(guardado), 'administrator');
    await estado.conta.get('labels');
    notas.push(`vínculo do conector ${guardado} com a conta ${contaId} refeito`);
  }
  notas.push(...(await passoAdminsDD(q, x, estado, contaId)));
  return notas;
}

/**
 * A lista de `KIT_ADMINS_DD` (csv): só e-mail de verdade entra. Variável definida mas sem nenhum e-mail (`,`, vazia de fato, lixo) dá AVISO e vale o padrão —
 * nunca uma lista vazia em silêncio (a conta nova ficaria sem a Doutor Digital).
 */
export function lerAdminsDD(valor: string | undefined): { lista: string[]; avisos: string[] } {
  if (valor === undefined || !valor.trim()) return { lista: ADMINS_DD_PADRAO, avisos: [] };
  const partes = valor.split(',').map((m) => m.trim()).filter(Boolean);
  const bons = partes.filter((m) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(m));
  const avisos: string[] = [];
  if (partes.length > bons.length) avisos.push(`KIT_ADMINS_DD: ${partes.length - bons.length} item(ns) não são e-mail e foram ignorados`);
  if (!bons.length) avisos.push('KIT_ADMINS_DD está definida mas não tem nenhum e-mail válido: usando o padrão');
  return { lista: bons.length ? bons : ADMINS_DD_PADRAO, avisos };
}

/**
 * O padrão: a Suzanne e o João (o usuário dele no CRM nasceu em 16/11 com `ops/kit-unidade/criar-usuario-dd-joao.sh`, administrador em todas as contas). Troca por
 * KIT_ADMINS_DD (csv) ou por `chatwoot.admins_dd` do questionário. Quem não está na conta de referência só gera aviso.
 */
export const ADMINS_DD_PADRAO = ['suzanne.mychelly1@gmail.com', 'doutordigitalconsultoria@gmail.com'];

/**
 * Põe os administradores da Doutor Digital na conta nova. O id deles vem da conta de REFERÊNCIA (`GET agents` da conta 1, só leitura) filtrado pela lista; a
 * entrada na conta é `account_users` (role administrator), que na plataforma só confere a permissão sobre a CONTA que o app criou. NUNCA se cria permissão do
 * app sobre usuário existente (daria ao token do app o poder de entrar como a pessoa). Idempotente: quem já é agente da conta nova não gera chamada.
 * E-mail que não está na conta 1 só gera aviso.
 */
async function passoAdminsDD(q: Questionario, x: PortasExternas, e: EstadoDaExecucao, contaId: number): Promise<string[]> {
  const desejados = [...new Set((q.chatwoot.admins_dd ?? x.adminsDD).map(lc))];
  if (!desejados.length) return ['administradores da Doutor Digital: nenhum na lista (KIT_ADMINS_DD vazio)'];
  const conta = daConta(e);
  const jaNaConta = new Set(listaDaResposta(await conta.get('agents')).map((a) => lc(String(a.email))));
  const faltam = desejados.filter((m) => !jaNaConta.has(m));
  if (!faltam.length) return [`administradores da Doutor Digital já estão na conta (${desejados.length})`];
  if (!x.referencia) return [`AVISO: sem a conta de referência não sei o id de ${mascararEmails(faltam).join(', ')}: não pus os administradores da Doutor Digital (ponha-os à mão no Super Admin)`];
  const naReferencia = new Map(listaDaResposta(await x.referencia.get('agents')).map((a) => [lc(String(a.email)), Number(a.id)] as const));
  const resolviveis = faltam.filter((m) => naReferencia.has(m));
  // só LER (o plano dizia «nada»): e-mail que não existe na conta 1 não é nada a fazer — só aviso, a cada rodada, sem tirar o passo do «nada»
  if (e.somenteLeitura && resolviveis.length) throw new ErroSoLeitura('pôr os administradores da Doutor Digital na conta');
  const plataforma = x.plataforma;
  if (!plataforma && resolviveis.length) return [`AVISO: sem o Platform App não dá para pôr ${mascararEmails(resolviveis).join(', ')} na conta`];
  const notas: string[] = [];
  for (const m of faltam) {
    const id = naReferencia.get(m);
    if (!id) {
      notas.push(`AVISO: ${mascararEmails([m])[0]} não está na conta de referência (conta 1): não pus na conta ${contaId} — confira o e-mail`);
      continue;
    }
    await plataforma!.vincular(contaId, id, 'administrator');
    notas.push(`${mascararEmails([m])[0]} (usuário ${id}) posto(a) como administrador(a) da conta ${contaId}`);
  }
  return notas;
}

// ── 2. o que vai dentro da conta ─────────────────────────────────────────────────────────────────────

export async function passoEtiquetas(x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const tem = new Set(listaDaResposta(await conta.get('labels')).map((l) => String(l.title)));
  const molde = x.referencia ? listaDaResposta(await x.referencia.get('labels')) : [];
  const porTitulo = new Map(molde.map((l) => [String(l.title), l]));
  // as que o código lê + as «perdido-*» (uma por motivo) da conta de referência
  const querer = [...new Set([...ETIQUETAS_DO_CODIGO, ...molde.map((l) => String(l.title)).filter((t) => /^perdido-/.test(t))])];
  const criadas: string[] = [];
  for (const titulo of querer) {
    if (tem.has(titulo)) continue;
    const m = porTitulo.get(titulo);
    await postar(e, conta, 'labels', { title: titulo, description: m?.description ?? '', color: m?.color ?? '#1f93ff', show_on_sidebar: m?.show_on_sidebar ?? true });
    criadas.push(titulo);
  }
  return [criadas.length ? `${criadas.length} etiqueta(s) criada(s)${x.referencia ? '' : ' (sem conta de referência: cor e descrição padrão)'}` : 'todas já existiam'];
}

export async function passoAtributos(x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const notas: string[] = [];
  for (const [modelo, chaves, rotulo] of [[0, ATRIBUTOS_DE_CONVERSA, 'conversa'], [1, ATRIBUTOS_DE_CONTATO, 'contato']] as const) {
    const tem = new Set(listaDaResposta(await conta.get('custom_attribute_definitions', { attribute_model: String(modelo) })).map((a) => String(a.attribute_key)));
    const molde = x.referencia ? listaDaResposta(await x.referencia.get('custom_attribute_definitions', { attribute_model: String(modelo) })) : [];
    const porChave = new Map(molde.map((a) => [String(a.attribute_key), a]));
    let criados = 0;
    for (const chave of chaves) {
      if (tem.has(chave)) continue;
      const m = porChave.get(chave);
      await postar(e, conta, 'custom_attribute_definitions', {
        attribute_key: chave,
        attribute_display_name: m?.attribute_display_name ?? chave,
        attribute_display_type: m?.attribute_display_type ?? 'text',
        attribute_description: m?.attribute_description ?? '',
        attribute_values: m?.attribute_values ?? [],
        attribute_model: modelo,
      });
      criados++;
    }
    notas.push(criados ? `${criados} atributo(s) de ${rotulo} criado(s)` : `atributos de ${rotulo}: já existiam`);
  }
  if (!x.referencia) notas.push('sem conta de referência: criados como texto simples (a lista de opções da etapa precisa ser conferida)');
  return notas;
}

/** Tipo do Chatwoot (`attribute_display_type`) de cada tipo do questionário, pelo NOME do enum (é assim que o Chatwoot o devolve). `lista-multipla` não existe no Chatwoot: vira texto com as opções na descrição. */
const TIPO_DO_CHATWOOT: Readonly<Record<string, string>> = { texto: 'text', numero: 'number', moeda: 'currency', data: 'date', lista: 'list', checkbox: 'checkbox', 'lista-multipla': 'text' };

const NOMES_DOS_TIPOS = ['text', 'number', 'currency', 'percent', 'link', 'date', 'list', 'checkbox'];
/**
 * O tipo de um atributo como NOME («list»). O Chatwoot REAL devolve o nome (enum do Rails: `attribute_display_type: "list"`), mas aceita nome ou número na entrada e o kit já viu os dois:
 * quem compara tipo passa por aqui, nunca por `=== 6`.
 */
export function tipoDoAtributo(v: unknown): string {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) return NOMES_DOS_TIPOS[Number(v)] ?? String(v);
  return String(v ?? '').toLowerCase();
}
export const ehLista = (a: { attribute_display_type?: unknown } | undefined | null): boolean => tipoDoAtributo(a?.attribute_display_type) === 'list';

/** O que o atributo extra grava como descrição (a lista múltipla leva as opções, já que o Chatwoot não tem esse tipo). */
export const descricaoDoExtra = (x: { tipo: string; opcoes?: string[]; descricao?: string }): string =>
  [x.descricao ?? '', x.tipo === 'lista-multipla' && x.opcoes ? `Pode ter mais de um (separe por vírgula). Opções: ${x.opcoes.join('; ')}` : ''].filter(Boolean).join(' — ').slice(0, 1000);

/** Atributos de conversa EXTRAS da conta (`chatwoot.atributos_extras`): cria os que faltam; o que já existe nunca é trocado. */
export async function passoAtributosExtras(q: Questionario, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const extras = q.chatwoot.atributos_extras ?? [];
  const tem = new Set(listaDaResposta(await conta.get('custom_attribute_definitions', { attribute_model: '0' })).map((a) => String(a.attribute_key)));
  let criados = 0;
  for (const x of extras) {
    if (tem.has(x.chave)) continue;
    await postar(e, conta, 'custom_attribute_definitions', {
      attribute_key: x.chave,
      attribute_display_name: x.nome,
      attribute_display_type: TIPO_DO_CHATWOOT[x.tipo] ?? 'text',
      attribute_description: descricaoDoExtra(x),
      attribute_values: x.tipo === 'lista' ? x.opcoes ?? [] : [],
      attribute_model: 0,
    });
    criados++;
  }
  return [criados ? `${criados} atributo(s) extra(s) criado(s)` : 'atributos extras: já existiam'];
}

/** O que muda numa lista: as opções novas e as que saem (a ORDEM também conta: é a que a tela mostra). */
export function diferencaDaLista(hoje: readonly string[] | undefined, novas: readonly string[]): { entram: string[]; saem: string[]; igual: boolean } {
  const antes = hoje ?? [];
  return { entram: novas.filter((o) => !antes.includes(o)), saem: antes.filter((o) => !novas.includes(o)), igual: antes.length === novas.length && antes.every((o, i) => o === novas[i]) };
}

/** Troca as opções das listas de `chatwoot.listas` (cria a lista a partir da referência se a conta ainda não a tem). Só mexe nas opções, nunca no resto da definição. */
export async function passoListas(q: Questionario, x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const notas: string[] = [];
  for (const l of q.chatwoot.listas ?? []) {
    const modelo = LISTAS_EDITAVEIS[l.chave] === 'contato' ? 1 : 0;
    const def = listaDaResposta(await conta.get('custom_attribute_definitions', { attribute_model: String(modelo) })).find((a) => String(a.attribute_key) === l.chave);
    if (!def) {
      const molde = x.referencia ? listaDaResposta(await x.referencia.get('custom_attribute_definitions', { attribute_model: String(modelo) })).find((a) => String(a.attribute_key) === l.chave) : undefined;
      await postar(e, conta, 'custom_attribute_definitions', { attribute_key: l.chave, attribute_display_name: molde?.attribute_display_name ?? l.chave, attribute_display_type: 'list', attribute_description: molde?.attribute_description ?? '', attribute_values: l.opcoes, attribute_model: modelo });
      notas.push(`${l.chave}: criada com ${l.opcoes.length} opções`);
      continue;
    }
    // a conta tem o atributo, mas NÃO como lista (texto livre, criado à mão): o PATCH das opções não o transforma — falha claro em vez de dizer que aplicou
    if (!ehLista(def)) throw new ErroDaPorta(`${l.chave}: já existe como atributo do tipo «${tipoDoAtributo(def.attribute_display_type)}», não como lista, e o kit não troca o tipo de um atributo que existe. Mude o tipo na conta (Configurações → Atributos personalizados) ou tire esta chave de chatwoot.listas`);
    const d = diferencaDaLista((def.attribute_values as unknown[] | undefined)?.map(String), l.opcoes);
    if (d.igual) {
      notas.push(`${l.chave}: já estava igual`);
      continue;
    }
    await corrigir(e, conta, `custom_attribute_definitions/${def.id}`, { attribute_values: l.opcoes });
    notas.push(`${l.chave}: ${l.opcoes.length} opções (entram ${d.entram.length}, saem ${d.saem.length})`);
  }
  return notas;
}

/** Condições ou ações que apontam para um id da conta de referência (caixa, time, agente): não servem em outra conta. */
const ATRIBUTOS_COM_ID = new Set(['inbox_id', 'team_id', 'assignee_id']);
const ACOES_COM_ID = new Set(['assign_agent', 'assign_team', 'send_email_to_team', 'send_webhook_event', 'send_message', 'send_attachment']);

export async function passoAutomacoesDaConta(x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const ref = x.referencia;
  if (!ref) return ['SEM a conta de referência (Parauapebas) não há de onde copiar as automações nativas: refazer à mão na conta (as 8 estão no catálogo do kit)'];
  const tem = new Set(listaDaResposta(await conta.get('automation_rules')).map((r) => String(r.name)));
  const copiadas: string[] = [];
  const puladas: string[] = [];
  for (const r of listaDaResposta(await ref.get('automation_rules'))) {
    const nome = String(r.name);
    if (tem.has(nome)) continue;
    const condicoes = Array.isArray(r.conditions) ? r.conditions : [];
    const acoes = Array.isArray(r.actions) ? r.actions : [];
    if (condicoes.some((c: any) => ATRIBUTOS_COM_ID.has(String(c.attribute_key))) || acoes.some((a: any) => ACOES_COM_ID.has(String(a.action_name)))) {
      puladas.push(nome);
      continue;
    }
    await postar(e, conta, 'automation_rules', { name: nome, description: r.description ?? '', event_name: r.event_name, active: r.active !== false, conditions: condicoes, actions: acoes });
    copiadas.push(nome);
  }
  return [copiadas.length ? `${copiadas.length} automação(ões) copiada(s) da conta de referência` : 'nada a copiar (já existiam)', ...(puladas.length ? [`NÃO copiei (apontam para caixa, time ou agente da outra conta — refazer à mão): ${puladas.join('; ')}`] : [])];
}

export async function passoMensagensProntas(q: Questionario, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const config = configChatwootDoQuestionario(q);
  const tem = new Set(listaDaResposta(await conta.get('canned_responses')).map((r) => String(r.short_code)));
  let criadas = 0;
  const sem: string[] = [];
  for (const m of MENSAGENS_PRONTAS) {
    const codigo = `${q.whatsapp.prefixo_modelos.replace(/_$/, '')}-${m.codigo}`;
    if (tem.has(codigo)) continue;
    const { texto, faltando } = comDadosDaUnidade(m.texto, config.dadosModelos);
    if (faltando.length) {
      sem.push(`/${codigo} (falta ${faltando.join(', ')})`);
      continue;
    }
    await postar(e, conta, 'canned_responses', { short_code: codigo, content: texto });
    criadas++;
  }
  return [criadas ? `${criadas} mensagem(ns) pronta(s) criada(s)` : 'já existiam', ...(sem.length ? [`NÃO criei por falta de dado da unidade: ${sem.join(', ')}`] : [])];
}

// ── 3. caixa, time, atendentes ───────────────────────────────────────────────────────────────────────

export async function passoCaixa(q: Questionario, x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const nome = q.chatwoot.caixa_nome;
  const ja = listaDaResposta(await conta.get('inboxes')).find((i) => String(i.name) === nome);
  if (ja) {
    e.caixaId = Number(ja.id);
    return [`caixa ${ja.id} já existia`];
  }
  if (q.whatsapp.modo === 'demonstracao') {
    const nova = (await postar(e, conta, 'inboxes', { name: nome, channel: { type: 'api' } })) as { id?: number };
    e.caixaId = Number(nova.id);
    return [`caixa ${nova.id} criada como canal API (demonstração: não há número de WhatsApp nem Kapso)`];
  }
  const chave = precisa(await x.segredos.ler('KAPSO_API_KEY'), 'falta KAPSO_API_KEY (a chave do Kapso) no cofre/ambiente: a caixa de WhatsApp Cloud usa o Kapso');
  const nova = (await postar(e, conta, 'inboxes', {
    name: nome,
    channel: { type: 'whatsapp', phone_number: q.whatsapp.numero_oficial, provider: 'whatsapp_cloud', provider_config: { api_key: chave, phone_number_id: q.whatsapp.kapso_phone_number_id, business_account_id: q.whatsapp.waba_id } },
  })) as { id?: number };
  e.caixaId = Number(nova.id);
  return [`caixa ${nova.id} criada (WhatsApp Cloud pelo Kapso; chave não impressa)`];
}

export async function passoTime(q: Questionario, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const ja = listaDaResposta(await conta.get('teams')).find((t) => String(t.name) === q.chatwoot.time_nome);
  if (ja) {
    e.timeId = Number(ja.id);
    return [`time ${ja.id} já existia`];
  }
  const novo = (await postar(e, conta, 'teams', { name: q.chatwoot.time_nome, description: q.unidade.nome, allow_auto_assign: true })) as { id?: number };
  e.timeId = Number(novo.id);
  return [`time ${novo.id} criado`];
}

const membrosDaCaixa = async (conta: ContaPorta, caixa: number): Promise<Set<number>> => new Set(listaDaResposta(await conta.get(`inbox_members/${caixa}`)).map((m) => Number(m.id)));
const membrosDoTime = async (conta: ContaPorta, time: number): Promise<Set<number>> => new Set(listaDaResposta(await conta.get(`teams/${time}/team_members`)).map((m) => Number(m.id)));

/** Acha (ou convida) um agente por e-mail e devolve o id. */
async function agente(conta: ContaPorta, e: EstadoDaExecucao, nome: string, email: string, papel: 'agent' | 'administrator'): Promise<{ id: number; novo: boolean }> {
  const mapa = e.agentes.get(lc(email));
  if (mapa) return { id: mapa, novo: false };
  const ja = listaDaResposta(await conta.get('agents')).find((a) => lc(String(a.email)) === lc(email));
  if (ja) {
    e.agentes.set(lc(email), Number(ja.id));
    return { id: Number(ja.id), novo: false };
  }
  const novo = (await postar(e, conta, 'agents', { name: nome, email, role: papel })) as { id?: number };
  e.agentes.set(lc(email), Number(novo.id));
  return { id: Number(novo.id), novo: true };
}

export async function passoAtendentes(q: Questionario, e: EstadoDaExecucao, semCaixa = false): Promise<string[]> {
  const conta = daConta(e);
  // --sem-caixa: a caixa ainda não existe; convida e põe no time. A rodada com o número põe todos na caixa (quem já é agente só falta entrar nela)
  const caixa = semCaixa ? null : precisa(e.caixaId, 'a caixa ainda não existe (passo «caixa»)');
  const time = precisa(e.timeId, 'o time ainda não existe (passo «time»)');
  const convidados: string[] = [];
  const ids: number[] = [];
  for (const a of q.chatwoot.atendentes) {
    const r = await agente(conta, e, a.nome, a.email, 'agent');
    ids.push(r.id);
    if (r.novo) convidados.push(a.nome);
  }
  const naCaixa = caixa === null ? new Set<number>(ids) : await membrosDaCaixa(conta, caixa);
  const noTime = await membrosDoTime(conta, time);
  const faltamNaCaixa = ids.filter((i) => !naCaixa.has(i));
  const faltamNoTime = ids.filter((i) => !noTime.has(i));
  if (faltamNaCaixa.length) await postar(e, conta, 'inbox_members', { inbox_id: caixa, user_ids: faltamNaCaixa });
  if (faltamNoTime.length) await postar(e, conta, `teams/${time}/team_members`, { user_ids: faltamNoTime });
  return [convidados.length ? `${convidados.length} convite(s) enviado(s): ${convidados.join(', ')}` : 'todas já eram agentes', caixa === null ? (faltamNoTime.length ? `${faltamNoTime.length} entraram no time ${time} (a caixa só existe na rodada com o número)` : `já estavam no time ${time} (a caixa só existe na rodada com o número)`) : faltamNaCaixa.length || faltamNoTime.length ? `${faltamNaCaixa.length} entraram na caixa ${caixa} e ${faltamNoTime.length} no time ${time}` : `já estavam na caixa ${caixa} e no time ${time}`];
}

export async function passoUsuarioCelular(q: Questionario, e: EstadoDaExecucao, semCaixa = false): Promise<string[]> {
  const conta = daConta(e);
  const email = precisa(q.chatwoot.usuario_celular_email, 'o questionário não tem usuario_celular_email');
  const caixa = semCaixa ? null : precisa(e.caixaId, 'a caixa ainda não existe (passo «caixa»)');
  const r = await agente(conta, e, '📱 Celular da unidade', email, 'agent');
  e.celularId = r.id;
  if (caixa !== null && !(await membrosDaCaixa(conta, caixa)).has(r.id)) await postar(e, conta, 'inbox_members', { inbox_id: caixa, user_ids: [r.id] });
  return [r.novo ? `usuário do celular ${r.id} criado` : `usuário do celular ${r.id} já existia`];
}

/** O id do gerente (a atendente com função «gerente») na conta. */
export const gerenteDaConta = (q: Questionario, e: EstadoDaExecucao): number | null => {
  const g = q.chatwoot.atendentes.find((a) => a.funcao === 'gerente');
  return g ? (e.agentes.get(lc(g.email)) ?? null) : null;
};

// ── 4. webhook, aba do Funil, robô ───────────────────────────────────────────────────────────────────

/** O endereço que o Chatwoot desta conta chama: a chave `k` é derivada do token DA CONTA — a de outra conta não vale. */
export const urlDoWebhook = (x: PortasExternas, token: string): string => `${x.urlDoAgente}/api/public/chatwoot/evento?k=${chaveDoEvento(token)}`;
export const EVENTOS_DO_WEBHOOK = ['message_created', 'message_updated', 'conversation_created', 'conversation_updated', 'conversation_status_changed'];

export async function passoWebhook(x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const token = precisa(e.tokenDaConta, 'sem o token da conta');
  const url = urlDoWebhook(x, token);
  const existentes = listaDaResposta(await conta.get('webhooks'), 'webhooks');
  if (existentes.some((w) => String(w.url) === url)) return ['webhook da conta já existia (com a chave desta conta)'];
  const antigos = existentes.filter((w) => String(w.url).startsWith(`${x.urlDoAgente}/api/public/chatwoot/evento`));
  await postar(e, conta, 'webhooks', { url, subscriptions: EVENTOS_DO_WEBHOOK });
  return ['webhook da conta criado (a chave é derivada do token DESTA conta; endereço não impresso)', ...(antigos.length ? [`há ${antigos.length} webhook(s) antigo(s) para o agente com outra chave: apague pela tela do Chatwoot`] : [])];
}

/**
 * As abas (Dashboard Apps) de uma conta: «Funil» e «Tarefas» (a tela de tarefas, que dentro da conversa recebe a conversa aberta). A aba usa o LOGIN da
 * pessoa (o menu do Chatwoot entrega a sessão): a chave do token da conta NÃO vai na URL, que qualquer agente vê no iframe. UMA definição só: o kit e o
 * script `registrar-tarefas` (contas que já existem) usam esta.
 */
export const abasDaConta = (urlDoAgente: string, contaId: number): Array<{ title: string; content: Array<{ type: 'frame'; url: string }> }> => [
  { title: 'Funil', content: [{ type: 'frame', url: `${urlDoAgente}/funil?conta=${contaId}` }] },
  { title: 'Tarefas', content: [{ type: 'frame', url: `${urlDoAgente}/funil/tarefas?conta=${contaId}` }] },
];

export async function passoDashboardApp(x: PortasExternas, e: EstadoDaExecucao): Promise<string[]> {
  const conta = daConta(e);
  const contaId = precisa(e.contaId, 'sem o id da conta');
  const existentes = listaDaResposta(await conta.get('dashboard_apps'));
  const notas: string[] = [];
  for (const aba of abasDaConta(x.urlDoAgente, contaId)) {
    if (existentes.some((a) => String(a.title) === aba.title)) {
      notas.push(`aba «${aba.title}» já existia`);
      continue;
    }
    await postar(e, conta, 'dashboard_apps', aba);
    notas.push(`aba «${aba.title}» criada nesta conta, apontando para ${aba.content[0]!.url}`);
  }
  return notas;
}

export async function passoRobo(q: Questionario, x: PortasExternas, e: EstadoDaExecucao, ligar: boolean): Promise<string[]> {
  const conta = daConta(e);
  const token = precisa(e.tokenDaConta, 'sem o token da conta');
  const notas: string[] = [];
  const ja = listaDaResposta(await conta.get('agent_bots')).find((b) => String(b.name) === 'Sofia');
  if (ja) {
    e.botId = Number(ja.id);
    notas.push(`robô Sofia ${ja.id} já existia`);
  } else {
    const novo = (await postar(e, conta, 'agent_bots', { name: 'Sofia', description: `Sofia de ${q.unidade.nome}`, outgoing_url: urlDoWebhook(x, token) })) as { id?: number; access_token?: string };
    e.botId = Number(novo.id);
    if (novo.access_token) {
      await x.segredos.guardar(nomeDoSegredoDoRobo(q), novo.access_token);
      notas.push(`robô Sofia ${novo.id} criado; token guardado no cofre como ${nomeDoSegredoDoRobo(q)} (valor não impresso)`);
    } else notas.push(`robô Sofia ${novo.id} criado, mas o Chatwoot NÃO devolveu o token dele: pegue no painel do Chatwoot (Configurações › Robôs) e guarde como ${nomeDoSegredoDoRobo(q)}`);
  }
  if (ligar) {
    const caixa = precisa(e.caixaId, 'a caixa ainda não existe');
    const atual = (await conta.get(`inboxes/${caixa}/agent_bot`)) as { agent_bot?: { id?: number } | null; id?: number } | null;
    const idAtual = Number(atual?.agent_bot?.id ?? atual?.id);
    if (Number.isInteger(idAtual) && idAtual > 0 && idAtual !== e.botId) notas.push(`a caixa ${caixa} JÁ tem outro robô (${idAtual}): não troquei — confira no Chatwoot antes`);
    else if (idAtual === e.botId) notas.push(`robô já estava ligado na caixa ${caixa}`);
    else {
      await postar(e, conta, `inboxes/${caixa}/set_agent_bot`, { agent_bot: e.botId });
      notas.push(`robô ligado na caixa ${caixa}`);
    }
  } else notas.push('NÃO liguei o robô na caixa: só depois do teste da Sofia e de ligar a automação chatwoot-ia (rode com --ligar-robo)');
  return notas;
}

// ── 5. modelos na Meta (via Kapso) ───────────────────────────────────────────────────────────────────

export async function passoModelos(q: Questionario, x: PortasExternas): Promise<string[]> {
  const config = configChatwootDoQuestionario(q);
  const { modelos } = modelosDaUnidade(config.dadosModelos, config.prefixoModelos);
  const validos = modelos.filter((m) => !m.problemas.length);
  const recusados = modelos.filter((m) => m.problemas.length);
  const avisoRecusados = recusados.length ? [`${recusados.length} modelo(s) com problema NÃO foram enviados: ${recusados.map((m) => `${m.meta.name} (${m.problemas.join('; ')})`).join(' | ')}`] : [];
  if (q.whatsapp.modo === 'demonstracao') {
    return [`SECO (demonstração, sem WABA): ${validos.length} modelo(s) iriam à Meta e NENHUM foi enviado. Exemplo: ${validos.slice(0, 3).map((m) => m.meta.name).join(', ')}…`, ...avisoRecusados];
  }
  const kapso = precisa(x.kapso, 'sem a chave do Kapso (KAPSO_API_KEY) não dá para enviar os modelos');
  const waba = precisa(q.whatsapp.waba_id, 'sem waba_id');
  const ja = await kapso.modelos(waba);
  const faltam = validos.filter((m) => !(m.meta.name in ja));
  for (const m of faltam) await kapso.criarModelo(waba, m.meta as unknown as Record<string, unknown>);
  return [faltam.length ? `${faltam.length} modelo(s) enviado(s) à Meta (ficam PENDENTES de aprovação)` : 'todos os modelos já estavam na Meta', ...avisoRecusados];
}
