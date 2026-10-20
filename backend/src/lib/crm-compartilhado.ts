/**
 * DUAS UNIDADES NUM KOMMO SÓ — Petrópolis e Caxias (14/10/2026).
 *
 * Regra do João: são duas unidades de verdade que dividem um CRM (a conta `doutorhernialvp`). Cada uma tem a sua
 * franquia (o seu token da API Spine), a sua agenda, os seus vínculos, as suas automações e os seus relatórios.
 * O que diz de quem é cada cartão é o campo «⌂ Unidade de atendimento» (o robô `unidade-por-canal` e a SDR
 * preenchem). A tabela `unit_crm_compartilhado` liga as duas: Caxias usa o Kommo de Petrópolis; cada uma tem um
 * rótulo, que é o texto da opção no campo.
 *
 * O que este arquivo garante:
 *   - unidade sem linha na tabela → nada muda (`sem-divisao`): todo cartão da conta é dela, como sempre foi;
 *   - cartão com o rótulo de uma unidade → só ela mexe nele, com o token DELA;
 *   - cartão com o campo VAZIO (ou com um valor que nenhuma unidade usa) → não é de ninguém: nenhuma escrita na
 *     franquia e nenhum robô de franquia → Kommo mexe nele. Ele vai para a lista "sem unidade" (com quem casou
 *     pelo telefone), para a SDR escolher. Nunca é atribuído em silêncio.
 *
 * A irmã (Caxias) NÃO guarda credencial de Kommo: tudo que precisa do Kommo pede a conta da dona
 * (`contaDoKommo`). Assim nenhum worker antigo, que procura unidade com token do Kommo, varre a conta duas vezes.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { normalizar } from './franquia-sync.js';
import { CAMPO_UNIDADE } from './unidade-por-canal.js';
import { definirCarregadorDaTrava, definirTokensProtegidos } from './trava-escrita-franquia.js';
import type { KommoLead } from '../services/kommo.service.js';

export interface MembroDoCrm {
  unitId: string;
  contaUnitId: string;
  rotulo: string;
  /** O slug da unidade — para perguntar "a chave de alguém do grupo está ligada?" sem ir ao banco. */
  slug?: string;
}

export interface GrupoDoCrm {
  /** A unidade dona do Kommo (a que tem as credenciais). */
  contaUnitId: string;
  /** Quem divide a conta, com o rótulo de cada um — inclui a dona quando ela tem a sua linha. */
  membros: MembroDoCrm[];
}

// ── estado em memória: relido do banco a cada 30 s, como as automações ──────────────────────────────────────

const VALIDADE_MS = 30_000;
let linhas: MembroDoCrm[] = [];
let carregadoEm = 0;
let carregando: Promise<void> | null = null;

/** Relê a tabela e a lista de tokens que a trava de escrita protege. Lança se o banco falhar (a trava tenta de novo). */
export function recarregarCrmCompartilhado(): Promise<void> {
  if (carregando) return carregando;
  carregando = (async () => {
    try {
      const rows = (
        await prisma.unitCrmCompartilhado.findMany({
          where: { ativo: true },
          select: { unitId: true, contaUnitId: true, rotulo: true, unit: { select: { slug: true } } },
        })
      ).map((r) => ({ unitId: r.unitId, contaUnitId: r.contaUnitId, rotulo: r.rotulo, slug: r.unit.slug }));
      // Protege o token de TODA unidade de um grupo — membros e donas: escrever com qualquer um deles sem olhar o
      // cartão é exatamente o erro que a regra proíbe.
      const ids = [...new Set(rows.flatMap((r) => [r.unitId, r.contaUnitId]))];
      const tokens = ids.length
        ? (await prisma.unit.findMany({ where: { id: { in: ids } }, select: { spineToken: true } })).map((u) => u.spineToken)
        : [];
      linhas = rows;
      definirTokensProtegidos(tokens);
      carregadoEm = Date.now();
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}

async function membrosAtuais(): Promise<MembroDoCrm[]> {
  if (carregadoEm === 0) {
    await recarregarCrmCompartilhado().catch((err) => logger.warn({ err: String(err) }, 'crm-compartilhado: falhei ao ler a tabela'));
  } else if (Date.now() - carregadoEm > VALIDADE_MS) {
    void recarregarCrmCompartilhado().catch((err) => logger.warn({ err: String(err) }, 'crm-compartilhado: falhei ao reler a tabela — segue a última leitura'));
  }
  return linhas;
}

/** Carrega no boot e entrega o carregador à trava de escrita (que espera a 1ª leitura antes de liberar). */
export async function iniciarCrmCompartilhado(): Promise<void> {
  definirCarregadorDaTrava(recarregarCrmCompartilhado);
  await recarregarCrmCompartilhado().catch((err) => logger.warn({ err: String(err) }, 'crm-compartilhado: falhei ao ler a tabela no boot'));
  if (linhas.length) logger.info({ membros: linhas.map((l) => `${l.rotulo}`), contas: [...new Set(linhas.map((l) => l.contaUnitId))].length }, 'crm-compartilhado: contas divididas carregadas');
}

/** Só para teste. */
export function _semearCrmParaTeste(membros: MembroDoCrm[]): void {
  linhas = membros;
  carregadoEm = Date.now();
}

// ── decisões PURAS ───────────────────────────────────────────────────────────────────────────────────────────

/** O grupo de que a unidade faz parte — como membro ou como dona. `null` = o Kommo é só dela. */
export function grupoDe(unitId: string, todas: MembroDoCrm[]): GrupoDoCrm | null {
  const eu = todas.find((l) => l.unitId === unitId);
  const conta = eu?.contaUnitId ?? (todas.some((l) => l.contaUnitId === unitId) ? unitId : null);
  if (!conta) return null;
  return { contaUnitId: conta, membros: todas.filter((l) => l.contaUnitId === conta) };
}

/** O texto do campo «⌂ Unidade de atendimento» no cartão (pelo NOME do campo, sem acento/caixa). Vazio = null. */
export function valorDaUnidadeNoCartao(lead: Pick<KommoLead, 'custom_fields_values'> | null | undefined): string | null {
  const alvo = normalizar(CAMPO_UNIDADE);
  for (const f of lead?.custom_fields_values ?? []) {
    if (normalizar(f.field_name) !== alvo) continue;
    const v = f.values?.[0]?.value;
    const s = v === null || v === undefined ? '' : String(v).trim();
    return s || null;
  }
  return null;
}

export type Veredicto =
  /** Kommo de uma unidade só: o cartão é dela, como sempre foi. */
  | { tipo: 'sem-divisao' }
  | { tipo: 'desta'; rotulo: string }
  | { tipo: 'outra'; rotulo: string; unitId: string }
  /** Campo vazio: não é de ninguém até a SDR escolher. */
  | { tipo: 'sem-unidade' }
  /** O campo tem um valor que nenhuma unidade do grupo usa. */
  | { tipo: 'nao-configurada'; valor: string }
  /** Esta unidade está no grupo sem rótulo próprio (a dona sem a sua linha): não mexe em cartão nenhum. */
  | { tipo: 'sem-rotulo' };

export function veredictoDoCartao(grupo: GrupoDoCrm | null, unitId: string, valorNoCartao: string | null): Veredicto {
  if (!grupo) return { tipo: 'sem-divisao' };
  if (!grupo.membros.some((m) => m.unitId === unitId)) return { tipo: 'sem-rotulo' };
  if (!valorNoCartao) return { tipo: 'sem-unidade' };
  const dono = grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valorNoCartao));
  if (!dono) return { tipo: 'nao-configurada', valor: valorNoCartao };
  return dono.unitId === unitId ? { tipo: 'desta', rotulo: dono.rotulo } : { tipo: 'outra', rotulo: dono.rotulo, unitId: dono.unitId };
}

/**
 * O membro do grupo cujo rótulo é o valor do campo (sem acento/caixa) — não importa por qual unidade o evento chegou.
 * Campo vazio ou valor que nenhuma unidade usa: null.
 */
export function membroDoRotulo(grupo: GrupoDoCrm, valorNoCartao: string | null): MembroDoCrm | null {
  if (!valorNoCartao) return null;
  return grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valorNoCartao)) ?? null;
}

/** Pode esta unidade mexer neste cartão? (`sem-divisao` e `desta` sim; o resto não.) */
export function podeMexer(v: Veredicto): boolean {
  return v.tipo === 'sem-divisao' || v.tipo === 'desta';
}

export function rotulosDoGrupo(grupo: GrupoDoCrm): string {
  const r = grupo.membros.map((m) => m.rotulo);
  return r.length <= 1 ? r.join('') : `${r.slice(0, -1).join(', ')} ou ${r[r.length - 1]}`;
}

export function motivoSemUnidade(grupo: GrupoDoCrm): string {
  return `Escolha a ⌂ Unidade de atendimento do cartão (${rotulosDoGrupo(grupo)}) antes de marcar: esta conta do Kommo atende ${grupo.membros.length} unidades, cada uma com a sua agenda na franquia. Nada foi marcado.`;
}

// ── consultas que os workers e o widget usam ─────────────────────────────────────────────────────────────────

export async function grupoDaUnidade(unitId: string): Promise<GrupoDoCrm | null> {
  return grupoDe(unitId, await membrosAtuais());
}

/** De quem é este cartão, do ponto de vista desta unidade. */
export async function cartaoDaUnidade(unitId: string, lead: Pick<KommoLead, 'custom_fields_values'>): Promise<Veredicto> {
  const grupo = await grupoDaUnidade(unitId);
  return veredictoDoCartao(grupo, unitId, grupo ? valorDaUnidadeNoCartao(lead) : null);
}

/** As irmãs (usam o Kommo de outra): o sincronizador as inclui mesmo sem credencial de Kommo própria. */
export async function irmasSemKommoProprio(): Promise<string[]> {
  return (await membrosAtuais()).filter((m) => m.unitId !== m.contaUnitId).map((m) => m.unitId);
}

/** A unidade cujo Kommo esta usa: a dona, para a irmã; a própria, para todo o resto. */
export async function contaDoKommo<U extends Pick<Unit, 'id'>>(unit: U, carregar: (id: string) => Promise<Unit | null> = (id) => prisma.unit.findUnique({ where: { id } })): Promise<U | Unit> {
  const grupo = await grupoDaUnidade(unit.id);
  if (!grupo || grupo.contaUnitId === unit.id) return unit;
  return (await carregar(grupo.contaUnitId)) ?? unit;
}

/**
 * Para os workers que varrem por CONTA do Kommo (parados): se alguma destas unidades está num Kommo dividido,
 * devolve a dona (com as credenciais) e as unidades do grupo — cada uma varre com a sua chave e o seu token.
 */
export async function contaDividida(unidadesDaConta: Array<Pick<Unit, 'id'>>): Promise<{ grupo: GrupoDoCrm; conta: Unit; membros: Unit[] } | null> {
  for (const u of unidadesDaConta) {
    const grupo = await grupoDaUnidade(u.id);
    if (!grupo) continue;
    const ids = [...new Set([grupo.contaUnitId, ...grupo.membros.map((m) => m.unitId)])];
    const units = await prisma.unit.findMany({ where: { id: { in: ids } } });
    const conta = units.find((x) => x.id === grupo.contaUnitId);
    if (!conta) return null;
    const membros = grupo.membros.map((m) => units.find((x) => x.id === m.unitId)).filter((x): x is Unit => !!x);
    return { grupo, conta, membros };
  }
  return null;
}

/**
 * A unidade DONA deste cartão (linha de `units`) — é a chave DELA que vale para a automação. Kommo de uma unidade
 * só: a própria. Cartão sem unidade (ou com valor que ninguém usa): `null` — nenhuma automação mexe.
 */
export async function unidadeDonaDoCartao(
  unitDaConta: Unit,
  lead: Pick<KommoLead, 'custom_fields_values'>,
  carregar: (id: string) => Promise<Unit | null> = (id) => prisma.unit.findUnique({ where: { id } }),
): Promise<Unit | null> {
  const grupo = await grupoDaUnidade(unitDaConta.id);
  if (!grupo) return unitDaConta;
  const valor = valorDaUnidadeNoCartao(lead);
  const dono = valor ? grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valor)) : undefined;
  if (!dono) return null;
  return dono.unitId === unitDaConta.id ? unitDaConta : carregar(dono.unitId);
}

/**
 * Para o evento que chega pela dona da conta (webhook do Kommo) e só diz o número do cartão: a unidade dona dele.
 * Kommo de uma unidade só: a própria, sem ler nada. Kommo dividido: lê o cartão na conta da dona; sem unidade, com um
 * valor que ninguém usa ou ilegível = null (não é de ninguém: nada é registrado em nome de nenhuma das duas).
 */
export async function unidadeDonaPeloCartaoId(
  unitDaConta: Unit,
  leadId: number,
  lerCartao: (conta: Unit, leadId: number) => Promise<Pick<KommoLead, 'custom_fields_values'> | null> = lerCartaoNaConta,
  carregar: (id: string) => Promise<Unit | null> = (id) => prisma.unit.findUnique({ where: { id } }),
): Promise<Unit | null> {
  if (!(await grupoDaUnidade(unitDaConta.id))) return unitDaConta;
  const conta = await contaDoKommo(unitDaConta, carregar);
  const lead = await lerCartao(conta, leadId).catch(() => null);
  if (!lead) return null;
  return unidadeDonaDoCartao(unitDaConta, lead, carregar);
}

export type DonoDoCartao =
  /** Kommo de uma unidade só: a própria unidade do pedido, sem marca (a trava nem se aplica). */
  | { tipo: 'sem-divisao'; unit: Unit }
  /** A unidade do cartão, já marcada para a trava de escrita deixar passar. */
  | { tipo: 'unidade'; unit: Unit & { escritaConferida: true }; rotulo: string }
  | { tipo: 'recusa'; codigo: 'sem_unidade' | 'unidade_sem_franquia'; motivo: string };

export interface DepsDono {
  grupo: (unitId: string) => Promise<GrupoDoCrm | null>;
  carregar: (unitId: string) => Promise<Unit | null>;
}
const DEPS_DONO: DepsDono = {
  grupo: grupoDaUnidade,
  carregar: (id) => prisma.unit.findUnique({ where: { id } }),
};

/**
 * Kommo → franquia: com que unidade (e com que token) escrever por este cartão.
 *
 * `unitDoPedido` é a unidade pela qual o pedido chegou (o widget instalado na conta é o de Petrópolis, então todo
 * cartão — de Petrópolis ou de Caxias — chega por ela). Campo vazio ou unidade sem franquia: RECUSA, com a frase
 * pronta para a SDR. Nunca escolhe pelo telefone nem pelo anúncio: escrita na franquia só com o campo preenchido.
 */
export async function unidadeDoCartao(
  unitDoPedido: Unit,
  lead: Pick<KommoLead, 'custom_fields_values'>,
  deps: DepsDono = DEPS_DONO,
): Promise<DonoDoCartao> {
  const grupo = await deps.grupo(unitDoPedido.id);
  if (!grupo) return { tipo: 'sem-divisao', unit: unitDoPedido };
  const valor = valorDaUnidadeNoCartao(lead);
  if (!valor) return { tipo: 'recusa', codigo: 'sem_unidade', motivo: motivoSemUnidade(grupo) };
  const dono = grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valor));
  if (!dono) {
    return { tipo: 'recusa', codigo: 'unidade_sem_franquia', motivo: `A unidade "${valor}" deste cartão não está ligada a nenhuma franquia aqui. Corrija a ⌂ Unidade de atendimento (${rotulosDoGrupo(grupo)}). Nada foi marcado.` };
  }
  const u = dono.unitId === unitDoPedido.id ? unitDoPedido : await deps.carregar(dono.unitId);
  if (!u || !u.spineEnabled || !u.spineToken) {
    return { tipo: 'recusa', codigo: 'unidade_sem_franquia', motivo: `A franquia de ${dono.rotulo} ainda não está conectada neste sistema. Nada foi marcado — marque direto na franquia de ${dono.rotulo}.` };
  }
  return { tipo: 'unidade', unit: { ...u, escritaConferida: true }, rotulo: dono.rotulo };
}

/**
 * O widget e a Ponte chegam pela unidade onde estão instalados (a dona da conta) e dizem o cartão (`leadId`). Kommo
 * de uma unidade só: a própria, sem ler nada. Kommo dividido: lê o cartão na conta da dona e devolve a unidade do
 * campo — ou a recusa pronta (sem cartão, campo vazio, unidade sem franquia).
 */
export async function unidadeParaOCartao(
  unitDoPedido: Unit,
  leadId: number | null,
  lerCartao: (conta: Unit, leadId: number) => Promise<Pick<KommoLead, 'custom_fields_values'> | null> = lerCartaoNaConta,
): Promise<DonoDoCartao> {
  const grupo = await grupoDaUnidade(unitDoPedido.id);
  if (!grupo) return { tipo: 'sem-divisao', unit: unitDoPedido };
  if (!leadId) {
    return { tipo: 'recusa', codigo: 'sem_unidade', motivo: `Esta conta do Kommo atende ${grupo.membros.length} unidades (${rotulosDoGrupo(grupo)}) e o pedido não disse de qual cartão é. Atualize o widget ou abra pelo cartão.` };
  }
  const conta = await contaDoKommo(unitDoPedido);
  const lead = await lerCartao(conta, leadId).catch(() => null);
  if (!lead) return { tipo: 'recusa', codigo: 'sem_unidade', motivo: 'Não consegui ler este cartão no Kommo para saber a unidade. Tente de novo.' };
  return unidadeDoCartao(unitDoPedido, lead);
}

async function lerCartaoNaConta(conta: Unit, leadId: number): Promise<KommoLead | null> {
  // import dinâmico: este arquivo é importado pelos workers e pelos testes, e o cliente do Kommo puxa muita coisa
  const { createKommoClient } = await import('../services/kommo.service.js');
  if (!conta.kommoAccessToken) return null;
  return createKommoClient(conta).getLead(leadId);
}

/** Frase para a IA quando a conta é dividida: a agenda pela Sofia ainda não separa as duas unidades. */
export async function travaDaAgendaDaIa(unit: Pick<Unit, 'id'>): Promise<string | null> {
  const grupo = await grupoDaUnidade(unit.id);
  if (!grupo) return null;
  return (
    `AGENDA INDISPONÍVEL PARA A IA NESTA CONTA: ela atende ${grupo.membros.length} unidades (${rotulosDoGrupo(grupo)}), cada uma com a sua agenda, ` +
    'e a marcação pela IA ainda não separa as duas. NÃO ofereça horário nem diga que marcou: chame pausar_ia para a recepção marcar pelo widget do cartão.'
  );
}

// ── cartões sem unidade: a lista que vai para a SDR ──────────────────────────────────────────────────────────

interface Encontro {
  em: number;
  /** O ⚙ idClient (franquia) do cartão é o do paciente que esta unidade achou — a "origem" do cartão. */
  idClientConfere: boolean;
}
const semUnidade = new Map<string, { contaUnitId: string; leadId: number; nome: string; porRotulo: Map<string, Encontro> }>();
const SEM_UNIDADE_TTL_MS = 24 * 60 * 60_000;
const SEM_UNIDADE_MAX = 3_000;

/**
 * O sincronizador da unidade `rotulo` casou um paciente da franquia DELA com um cartão de campo vazio. Não mexe no
 * cartão; anota. Se a outra unidade também casar o mesmo cartão, a lista mostra "as duas" — e ninguém decide.
 */
export function anotarCartaoSemUnidade(contaUnitId: string, leadId: number, nome: string, rotulo: string, idClientConfere: boolean, agora = Date.now()): void {
  const k = `${contaUnitId}:${leadId}`;
  const e = semUnidade.get(k) ?? { contaUnitId, leadId, nome, porRotulo: new Map<string, Encontro>() };
  e.nome = nome || e.nome;
  e.porRotulo.set(rotulo, { em: agora, idClientConfere });
  semUnidade.set(k, e);
  if (semUnidade.size > SEM_UNIDADE_MAX) {
    let n = 0;
    for (const chave of semUnidade.keys()) { semUnidade.delete(chave); if (++n >= 500) break; }
  }
}

export interface CartaoSemUnidade {
  leadId: number;
  nome: string;
  /** As unidades cuja franquia tem este paciente (pelo telefone/vínculo do sincronizador). */
  casouCom: string[];
  /** Casou com mais de uma: a SDR decide, o sistema não. */
  nasDuas: boolean;
  /**
   * Só uma unidade casou E o ⚙ idClient (franquia) do cartão é o paciente dela: a origem do cartão é essa franquia
   * (caso típico da carga de implantação). É SUGESTÃO — nada é gravado.
   */
  sugestao: string | null;
}

export function cartoesSemUnidade(contaUnitId: string, agora = Date.now()): CartaoSemUnidade[] {
  const out: CartaoSemUnidade[] = [];
  for (const e of semUnidade.values()) {
    if (e.contaUnitId !== contaUnitId) continue;
    const vivos = [...e.porRotulo.entries()].filter(([, v]) => agora - v.em < SEM_UNIDADE_TTL_MS);
    if (!vivos.length) continue;
    const casouCom = vivos.map(([r]) => r).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const nasDuas = casouCom.length > 1;
    out.push({ leadId: e.leadId, nome: e.nome, casouCom, nasDuas, sugestao: !nasDuas && vivos[0][1].idClientConfere ? casouCom[0] : null });
  }
  return out.sort((a, b) => Number(b.nasDuas) - Number(a.nasDuas) || a.leadId - b.leadId);
}

/**
 * O portão dos robôs franquia → Kommo numa conta dividida: `true` = PULE este cartão. Conta o motivo no resumo.
 * `casouCom` só vem do sincronizador, quando a franquia DESTA unidade casou um paciente com o cartão: aí, se o campo
 * está vazio, o cartão entra na lista da SDR — com a sugestão pela origem quando o ⚙ idClient do cartão
 * (`idClientDoCartao`, a regra do #57: o idClient do cartão manda) é um dos ids do paciente casado. Quem só lista
 * cartões por etapa (revisão, 48 h, parados) não casou ninguém e não anota.
 * `grupo` null (Kommo de uma unidade só) = nunca pula: comportamento de sempre.
 */
export function pularCartao(
  grupo: GrupoDoCrm | null,
  unitId: string,
  lead: Pick<KommoLead, 'id' | 'name' | 'custom_fields_values'>,
  resumo: { deOutraUnidade?: number; semUnidade?: number },
  casouCom?: { idsClient: number[]; idDoCartao: number | null },
): boolean {
  if (!grupo) return false;
  const v = veredictoDoCartao(grupo, unitId, valorDaUnidadeNoCartao(lead));
  if (podeMexer(v)) return false;
  if (v.tipo === 'sem-unidade') {
    resumo.semUnidade = (resumo.semUnidade ?? 0) + 1;
    const rotulo = grupo.membros.find((m) => m.unitId === unitId)?.rotulo;
    if (casouCom && rotulo) {
      const confere = casouCom.idDoCartao !== null && casouCom.idsClient.includes(casouCom.idDoCartao);
      anotarCartaoSemUnidade(grupo.contaUnitId, lead.id, lead.name ?? '', rotulo, confere);
    }
  } else {
    resumo.deOutraUnidade = (resumo.deOutraUnidade ?? 0) + 1;
  }
  return true;
}

/** Só para teste. */
export function _zerarSemUnidadeParaTeste(): void {
  semUnidade.clear();
}
