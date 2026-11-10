/**
 * O SINAL por Pix da Sofia 2.0: um link de pagamento no Asaas DA unidade, criado quando o paciente escolhe "garantir com sinal".
 *
 * Decisão do João (10/11/2026): em Araguaína, Açailândia, Imperatriz, Marabá, Porto Nacional, Balsas e Canaã a consulta é R$ 350 no
 * dia, ou R$ 250 garantindo com um sinal de R$ 50 pago AGORA por um Pix que a própria Sofia gera (+ R$ 200 no dia). Ligado por
 * unidade pela flag `Unit.sinalPixCentavos` (nulo = nada muda; ver `unidadeComSinal`).
 *
 * POR QUE LINK DE PAGAMENTO E NÃO COBRANÇA (`/payments`): cobrança exige cliente com CPF no Asaas e a Sofia não coleta CPF. O link
 * não exige — o pagador preenche na página do Asaas. O link nasce com `limit: 1` (uma venda só) e `endDate` (véspera da consulta).
 *
 * REGRAS:
 *  - Idempotente: um link pendente por paciente. Pedir de novo devolve o MESMO link (nunca cria outro); sinal já pago devolve "já pago".
 *  - Teto por unidade por dia (`SINAL_PIX_TETO_DIA`, padrão 40): não vira fábrica de links.
 *  - A escrita no Asaas passa por `asaasEscrever`, que só aceita a rota `POST /paymentLinks` (e nenhuma outra de link).
 *  - Falha do Asaas (sem chave, 401/403, timeout) NUNCA lança: devolve `falhou` e quem chama (a ferramenta) manda a Sofia dizer que a equipe
 *    envia o Pix e abre a tarefa para a SDR. Timeout pode ter criado o link: o `externalReference` (sofia-sinal:<slug>:<lead>) deixa achá-lo no painel.
 *  - A baixa NÃO usa webhook (os do Asaas dessas contas apontam para outro sistema): `sinal-pix-worker.ts` lê /payments.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { asaasEscrever } from './integracoes/asaas-escrita.js';
import { chaveDaUnidade } from './integracoes/chaves.js';
import { partesNoFuso } from './fuso.js';
import { unidadeDona } from '../agent/rede-doutor-hernia.js';

/** Id da automação no catálogo (tela de Automações; variável SINAL_PIX_SLUGS): liga a BAIXA do sinal (`sinal-pix-worker.ts`). */
export const ID_SINAL_PIX = 'sinal-pix';
export const TETO_LINKS_POR_UNIDADE_DIA = Number(process.env.SINAL_PIX_TETO_DIA) || 40;
/** Quanto tempo atrás ainda vale um sinal (pendente ou pago) como "o deste paciente": passado isso é de outra consulta. */
export const VALIDADE_DO_SINAL_DIAS = 45;
const DIAS_MAXIMOS_DO_LINK = 60;

export interface LinhaDoSinal {
  id: string;
  unitId: string;
  leadId: string;
  linkId: string;
  url: string;
  valorCentavos: number;
  venceEm: string;
  status: string;
  paymentId: string | null;
  criadoEm: Date;
  pagoEm: Date | null;
  avisadoEm: Date | null;
}

/** O pedaço do Prisma que este módulo usa (a fachada permite testar sem banco). */
export interface BancoDoSinal {
  findFirst(args: { where: { unitId: string; leadId: string; status: { in: string[] }; criadoEm: { gte: Date } }; orderBy: { criadoEm: 'desc' } }): Promise<LinhaDoSinal | null>;
  count(args: { where: { unitId: string; criadoEm: { gte: Date } } }): Promise<number>;
  create(args: { data: { unitId: string; leadId: string; linkId: string; url: string; valorCentavos: number; venceEm: string } }): Promise<LinhaDoSinal>;
}

export interface DepsDoSinal {
  banco: BancoDoSinal;
  /**
   * Uma geração por paciente por vez. Em produção: transação com `pg_advisory_xact_lock` (vale entre instâncias, como no rolling update);
   * o padrão, em memória, serve ao teste. `fn` recebe o banco a usar DENTRO da trava.
   */
  travar?: <T>(chave: string, fn: (banco: BancoDoSinal) => Promise<T>) => Promise<T>;
  chave: (unit: { id: string; slug: string }) => Promise<{ unitId: string; slug: string; chave: string } | null>;
  escrever: typeof asaasEscrever;
  agora: () => Date;
}

/**
 * A chave do Asaas da CLÍNICA desta unidade. O cofre indexa por unidade (`ChaveDeIntegracao.unitId`); a unidade "Resgate"
 * (`araguaina-resgate`) não é outra clínica: divide a conta da dona (`doutor-hernia-araguaina`, ver `unidadeDona`). Então: a chave da
 * própria unidade, se existir; senão a da dona — e SÓ a da dona (slug `-resgate`/`-tratamento`/`-financeiro`). Unidade sem dona e sem chave
 * própria = null: nunca a conta de outra clínica.
 */
export async function chaveDaClinica(unit: { id: string; slug: string }): Promise<{ unitId: string; slug: string; chave: string } | null> {
  const propria = await chaveDaUnidade(unit.id, 'asaas');
  if (propria) return propria;
  const dona = unidadeDona(unit.slug);
  if (dona === unit.slug) return null;
  const u = await prisma.unit.findUnique({ where: { slug: dona }, select: { id: true } });
  return u ? chaveDaUnidade(u.id, 'asaas') : null;
}

/** "Doutor Hérnia Araguaína" / "Araguaína - Resgate" → "Araguaína": o nome da clínica no título do link. */
export function nomeDaClinica(nome: string): string {
  return nome.replace(/^\s*doutor\s+h[eé]rnia\s*[-–·:]?\s*/i, '').replace(/\s*[-–·:]?\s*(resgate|tratamento|financeiro)\s*$/i, '').trim() || nome;
}

export const depsReais = (): DepsDoSinal => ({
  banco: prisma.sinalPix as unknown as BancoDoSinal,
  travar: (chave, fn) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chave}))`;
        return fn(tx.sinalPix as unknown as BancoDoSinal);
      },
      // o Asaas pode levar até 30 s: a trava segura a transação esse tempo (raro: um sinal por paciente)
      { timeout: 45_000, maxWait: 10_000 },
    ),
  chave: chaveDaClinica,
  escrever: asaasEscrever,
  agora: () => new Date(),
});

export type MotivoDaFalha = 'sem-chave' | 'teto' | 'asaas' | 'baixa-desligada';

export type ResultadoDoSinal =
  | { tipo: 'link'; url: string; novo: boolean; valor: number; venceEm: string }
  | { tipo: 'ja-pago' }
  | { tipo: 'falhou'; motivo: MotivoDaFalha; detalhe: string };

export interface UnidadeDoSinal {
  id: string;
  slug: string;
  name: string;
  sinalPixCentavos: number | null;
  spineTimezone?: string | null;
}

/** "AAAA-MM-DD" de um instante no fuso da unidade. */
export function diaNoFuso(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** "2026-11-14" → "14/11". */
export const diaCurto = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Até quando o link vale: a véspera da consulta, nunca antes de hoje e nunca mais de 60 dias à frente. Sem a data da consulta, 3 dias.
 * (A regra de sempre do antecipado: "pode pagar até a véspera".)
 */
export function validadeDoLink(hoje: string, diaDaConsulta: string | null): string {
  const teto = somarDias(hoje, DIAS_MAXIMOS_DO_LINK);
  const alvo = diaDaConsulta && /^\d{4}-\d{2}-\d{2}$/.test(diaDaConsulta) ? somarDias(diaDaConsulta, -1) : somarDias(hoje, 3);
  if (alvo < hoje) return hoje;
  return alvo > teto ? teto : alvo;
}

/** O link tem de ser https e do Asaas: é o que a Sofia manda ao paciente, então nada vindo de uma resposta estranha. */
export function urlDoAsaasValida(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)asaas\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// Uma geração por paciente por vez: duas chamadas juntas (retry da ferramenta, dois turnos) esperam a primeira e então a enxergam no banco.
const emCurso = new Map<string, Promise<unknown>>();
async function umPorVez<T>(chave: string, fn: () => Promise<T>): Promise<T> {
  const anterior = emCurso.get(chave) ?? Promise.resolve();
  const minha = anterior.then(fn, fn);
  const fila = minha.catch(() => undefined);
  emCurso.set(chave, fila);
  try {
    return await minha;
  } finally {
    if (emCurso.get(chave) === fila) emCurso.delete(chave);
  }
}

export async function gerarSinalPix(
  unit: UnidadeDoSinal,
  leadId: number,
  diaDaConsulta: string | null,
  deps: DepsDoSinal = depsReais(),
): Promise<ResultadoDoSinal> {
  const centavos = unit.sinalPixCentavos;
  if (!Number.isInteger(centavos) || (centavos as number) <= 0) return { tipo: 'falhou', motivo: 'asaas', detalhe: 'a unidade não tem sinal configurado' };
  const travar = deps.travar ?? ((chave, fn) => umPorVez(chave, () => fn(deps.banco)));
  return travar(`sinal-pix:${unit.id}:${leadId}`, async (banco) => {
    const agora = deps.agora();
    const fuso = unit.spineTimezone && unit.spineTimezone.trim() ? unit.spineTimezone : 'America/Sao_Paulo';
    const hoje = diaNoFuso(agora, fuso);
    const venceEm = validadeDoLink(hoje, diaDaConsulta);

    // 1) Já existe sinal deste paciente? Pago vale mais que pendente; pendente só serve se ainda cobre a data pedida.
    const desde = new Date(agora.getTime() - VALIDADE_DO_SINAL_DIAS * 86_400_000);
    const pago = await banco.findFirst({ where: { unitId: unit.id, leadId: String(leadId), status: { in: ['pago'] }, criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' } });
    if (pago) return { tipo: 'ja-pago' as const };
    const pendente = await banco.findFirst({ where: { unitId: unit.id, leadId: String(leadId), status: { in: ['pendente'] }, criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' } });
    // Link pendente que ainda vale é SEMPRE reaproveitado, mesmo que acabe antes da (nova) consulta: o Asaas não deixa cancelar link por aqui
    // (DELETE/PUT de link são rotas proibidas), então um segundo link deixaria dois Pix pagáveis para o mesmo paciente. Venceu, aí sim um novo.
    if (pendente && pendente.venceEm >= hoje && pendente.valorCentavos === centavos) {
      return { tipo: 'link' as const, url: pendente.url, novo: false, valor: pendente.valorCentavos / 100, venceEm: pendente.venceEm };
    }

    // 2) Teto do dia da unidade (últimas 24 h): só conta o que é NOVO, reaproveitar não gasta.
    const criadosHoje = await banco.count({ where: { unitId: unit.id, criadoEm: { gte: new Date(agora.getTime() - 86_400_000) } } });
    if (criadosHoje >= TETO_LINKS_POR_UNIDADE_DIA) {
      logger.warn({ unit: unit.slug, criadosHoje, teto: TETO_LINKS_POR_UNIDADE_DIA }, 'sinal-pix: teto de links por dia atingido');
      return { tipo: 'falhou', motivo: 'teto', detalhe: `${criadosHoje} links nas últimas 24 h (teto ${TETO_LINKS_POR_UNIDADE_DIA})` };
    }

    // 3) A chave do Asaas da unidade (cofre do conector). Sem ela, a equipe manda o Pix.
    const conta = await deps.chave({ id: unit.id, slug: unit.slug }).catch(() => null);
    if (!conta) return { tipo: 'falhou', motivo: 'sem-chave', detalhe: 'a unidade não tem chave do Asaas no cofre' };

    // 4) Cria o link. Qualquer erro vira `falhou` (a chave nunca aparece: asaasEscrever já a tira das mensagens).
    const valor = (centavos as number) / 100;
    let criado: { id?: unknown; url?: unknown } | null;
    try {
      criado = await deps.escrever<{ id?: unknown; url?: unknown }>(conta.unitId, conta.chave, 'POST', '/paymentLinks', {
        name: `Sinal consulta Doutor Hérnia ${nomeDaClinica(unit.name)}`,
        description: `Sinal de R$ ${valor.toFixed(2).replace('.', ',')} para garantir a consulta (o restante é pago na clínica, no dia).`,
        billingType: 'PIX',
        chargeType: 'DETACHED',
        value: valor,
        limit: 1,
        endDate: venceEm,
        externalReference: `sofia-sinal:${unit.slug}:${leadId}`,
        notificationEnabled: false,
      });
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      logger.warn({ unit: unit.slug, leadId, detalhe }, 'sinal-pix: o Asaas não criou o link');
      return { tipo: 'falhou', motivo: 'asaas', detalhe: detalhe.slice(0, 300) };
    }
    const linkId = typeof criado?.id === 'string' || typeof criado?.id === 'number' ? String(criado.id) : '';
    if (!linkId || !urlDoAsaasValida(criado?.url)) {
      logger.warn({ unit: unit.slug, leadId, linkId: linkId || null }, 'sinal-pix: resposta do Asaas sem id ou sem url válida');
      return { tipo: 'falhou', motivo: 'asaas', detalhe: 'resposta do Asaas sem id ou sem link válido' };
    }

    // 5) Guarda. Se o banco falhar o link já existe no Asaas: o paciente ainda pode pagar (sem baixa automática) e o log deixa o rastro.
    try {
      await banco.create({ data: { unitId: unit.id, leadId: String(leadId), linkId, url: criado.url, valorCentavos: centavos as number, venceEm } });
    } catch (err) {
      logger.error({ err: String(err), unit: unit.slug, leadId, linkId }, 'sinal-pix: link criado no Asaas mas NÃO gravado no banco — sem baixa automática');
    }
    logger.info({ unit: unit.slug, leadId, linkId, venceEm }, 'sinal-pix: link criado');
    return { tipo: 'link', url: criado.url, novo: true, valor, venceEm };
  });
}
