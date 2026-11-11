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
 *  - Idempotente: um link pendente por paciente DA CLÍNICA (comercial e Resgate dividem cartão e conta Asaas). Pedir de novo devolve o MESMO
 *    link; sinal já pago da consulta devolve "já pago"; consulta nova (a anterior passou) pede sinal novo.
 *  - Teto por clínica por dia (`SINAL_PIX_TETO_DIA`, padrão 40): não vira fábrica de links.
 *  - A escrita no Asaas passa por `asaasEscrever`, que só aceita a rota `POST /paymentLinks` (e nenhuma outra de link).
 *  - Falha do Asaas (sem chave, 401/403, timeout) NUNCA lança: devolve `falhou` e quem chama (a ferramenta) manda a Sofia dizer que a equipe
 *    envia o Pix e abre a tarefa para a SDR. Timeout pode ter criado o link: o `externalReference` (sofia-sinal:<slug>:<lead>) deixa achá-lo no painel.
 *  - A baixa NÃO usa webhook (os do Asaas dessas contas apontam para outro sistema): `sinal-pix-worker.ts` lê /payments.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { asaasEscrever } from './integracoes/asaas-escrita.js';
import { asaasGet } from './integracoes/asaas.js';
import { chaveDaUnidade } from './integracoes/chaves.js';
import { fusoDaUnidade, partesNoFuso } from './fuso.js';
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
  /** a clínica dona (`unidadeDona`): comercial e Resgate dividem o cartão e a conta Asaas */
  clinica: string;
  leadId: string;
  linkId: string;
  url: string;
  valorCentavos: number;
  venceEm: string;
  /** "AAAA-MM-DDTHH:mm" no relógio da unidade: a consulta que este sinal garante */
  consultaEm: string;
  status: string;
  paymentId: string | null;
  criadoEm: Date;
  pagoEm: Date | null;
  avisadoEm: Date | null;
}

export interface DadosDoSinal {
  unitId: string;
  clinica: string;
  leadId: string;
  linkId: string;
  url: string;
  valorCentavos: number;
  venceEm: string;
  consultaEm: string;
  status?: string;
}

/** O pedaço do Prisma que este módulo usa (a fachada permite testar sem banco). */
export interface BancoDoSinal {
  findMany(args: { where: { clinica: string; leadId: string; status: { in: string[] }; criadoEm: { gte: Date } }; orderBy: { criadoEm: 'desc' } }): Promise<LinhaDoSinal[]>;
  count(args: { where: { clinica: string; criadoEm: { gte: Date } } }): Promise<number>;
  create(args: { data: DadosDoSinal }): Promise<LinhaDoSinal>;
  updateMany(args: { where: { id: string }; data: Partial<Pick<LinhaDoSinal, 'linkId' | 'url' | 'status' | 'consultaEm'>> }): Promise<{ count: number }>;
  deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
}

export interface DepsDoSinal {
  banco: BancoDoSinal;
  /**
   * Uma checagem+reserva por paciente por vez (SÓ essa fase curta: a chamada ao Asaas fica FORA da trava e da transação). Em produção:
   * transação com `pg_advisory_xact_lock` (vale entre instâncias, como no rolling update); o padrão, em memória, serve ao teste.
   * `fn` recebe o banco a usar DENTRO da trava.
   */
  travar?: <T>(chave: string, fn: (banco: BancoDoSinal) => Promise<T>) => Promise<T>;
  chave: (unit: { id: string; slug: string }) => Promise<{ unitId: string; slug: string; chave: string } | null>;
  escrever: typeof asaasEscrever;
  /**
   * Leitura no Asaas (a chave Pix da conta). Com ela o sinal sai como Pix COPIA-E-COLA de valor fixo (`POST /pix/qrCodes/static`): o
   * paciente cola no app do banco, sem formulário. Sem ela (testes antigos), o link de pagamento de antes.
   */
  ler?: typeof asaasGet;
  agora: () => Date;
  /** espera enquanto outra geração do mesmo paciente termina (o teste encurta) */
  esperar?: (ms: number) => Promise<void>;
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
      // transação curta: só a checagem e a reserva da linha; a chamada ao Asaas (até 30 s) acontece depois, fora dela
      { timeout: 15_000, maxWait: 10_000 },
    ),
  chave: chaveDaClinica,
  escrever: asaasEscrever,
  ler: asaasGet,
  agora: () => new Date(),
});

export type MotivoDaFalha = 'sem-chave' | 'teto' | 'asaas' | 'baixa-desligada' | 'em-andamento';

export type ResultadoDoSinal =
  /** `registrado` = false: o link existe no Asaas mas NÃO ficou gravado no banco (a baixa automática não o enxerga) */
  | { tipo: 'link'; url: string; novo: boolean; valor: number; venceEm: string; registrado?: boolean; copiaECola?: boolean }
  | { tipo: 'ja-pago' }
  | { tipo: 'falhou'; motivo: MotivoDaFalha; detalhe: string };

export interface UnidadeDoSinal {
  id: string;
  slug: string;
  name: string;
  sinalPixCentavos: number | null;
  spineTimezone?: string | null;
  businessHoursTimezone?: string | null;
}

/** "AAAA-MM-DD" de um instante no fuso da unidade. */
export function diaNoFuso(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** "AAAA-MM-DDTHH:mm" de um instante no fuso da unidade — o mesmo formato de `SpineLeadLink.agendadoPara`, comparável como texto. */
export function instanteLocal(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  return `${diaNoFuso(d, fuso)}T${String(p.hora).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

/** O relógio da unidade (fuso validado). */
export const fusoDoSinal = (u: { spineTimezone?: string | null; businessHoursTimezone?: string | null }): string =>
  fusoDaUnidade({ spineTimezone: u.spineTimezone ?? undefined, businessHoursTimezone: u.businessHoursTimezone ?? undefined });

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

/**
 * O Pix copia-e-cola (BR Code EMV): começa com "000201", tem o domínio do Pix do Banco Central e termina no CRC "6304XXXX".
 * Espaço é normal (nome e cidade do recebedor: "ATTIVA CORPO E MENTE"); quebra de linha, não.
 */
export function copiaEColaValido(p: unknown): p is string {
  return typeof p === 'string' && /^000201/.test(p) && /br\.gov\.bcb\.pix/i.test(p) && /6304[0-9A-F]{4}$/i.test(p) && p.length <= 512 && !/[\r\n]/.test(p);
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

// Em memória (teste e fallback): uma checagem por paciente por vez.
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

/** Reserva de outra geração em curso: depois disto ela é tida como morta (o processo caiu no meio). */
const RESERVA_VALE_MS = 2 * 60_000;
const ESPERA_MAXIMA_VOLTAS = 45; // x 1 s

type Fase1 = { tipo: 'pronto'; resultado: ResultadoDoSinal } | { tipo: 'espera' } | { tipo: 'reservado'; reserva: LinhaDoSinal };

/**
 * O sinal é da CLÍNICA e da CONSULTA, não da unidade:
 *  - comercial e Resgate dividem o mesmo cartão e a mesma conta Asaas, então trava, busca de link existente, "já pago" e teto são por
 *    clínica dona (`unidadeDona`) + cartão. Uma unidade nunca gera 2º link para quem a outra já atendeu, nem cobra quem já pagou;
 *  - vale para a consulta para a qual foi gerado (`consultaEm`) e para a REMARCAÇÃO dela (`acompanharRemarcacao` move a data). Consulta
 *    que já passou (compareceu ou faltou) e consulta NOVA pedem sinal novo. A regra da falta é decisão pendente do João.
 * `quando` = "AAAA-MM-DDTHH:mm" da consulta (de `SpineLeadLink.agendadoPara`).
 */
export async function gerarSinalPix(
  unit: UnidadeDoSinal,
  leadId: number,
  quando: string | null,
  deps: DepsDoSinal = depsReais(),
): Promise<ResultadoDoSinal> {
  const centavos = unit.sinalPixCentavos;
  if (!Number.isInteger(centavos) || (centavos as number) <= 0) return { tipo: 'falhou', motivo: 'asaas', detalhe: 'a unidade não tem sinal configurado' };
  const clinica = unidadeDona(unit.slug);
  const travar = deps.travar ?? ((chave, fn) => umPorVez(chave, () => fn(deps.banco)));
  const esperar = deps.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fuso = fusoDoSinal(unit);
  const dia = quando && /^\d{4}-\d{2}-\d{2}/.test(quando) ? quando.slice(0, 10) : null;

  // Fase 1 (curta, sob trava): o que já existe, o teto, e a RESERVA da linha. A chamada ao Asaas fica fora da trava.
  const fase1 = (): Promise<Fase1> =>
    travar(`sinal-pix:${clinica}:${leadId}`, async (banco): Promise<Fase1> => {
      const agora = deps.agora();
      const hoje = diaNoFuso(agora, fuso);
      const agoraLocal = instanteLocal(agora, fuso);
      const venceEm = validadeDoLink(hoje, dia);
      const desde = new Date(agora.getTime() - VALIDADE_DO_SINAL_DIAS * 86_400_000);
      const linhas = await banco.findMany({ where: { clinica, leadId: String(leadId), status: { in: ['pago', 'pendente', 'criando'] }, criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' } });
      // só conta o que é da consulta de agora: sinal de consulta que já passou não vale para uma consulta nova
      const vigentes = linhas.filter((l) => (l.status === 'criando' ? agora.getTime() - l.criadoEm.getTime() < RESERVA_VALE_MS : l.consultaEm >= agoraLocal));
      if (vigentes.some((l) => l.status === 'pago')) return { tipo: 'pronto', resultado: { tipo: 'ja-pago' } };
      if (vigentes.some((l) => l.status === 'criando')) return { tipo: 'espera' };
      // Link pendente que ainda vale é SEMPRE reaproveitado, mesmo que acabe antes da (nova) consulta: o Asaas não deixa cancelar link por aqui
      // (DELETE/PUT de link são rotas proibidas), então um segundo link deixaria dois Pix pagáveis para o mesmo paciente. Venceu, aí sim um novo.
      const pendente = vigentes.find((l) => l.status === 'pendente' && l.venceEm >= hoje && l.valorCentavos === centavos);
      if (pendente) {
        return {
          tipo: 'pronto',
          resultado: { tipo: 'link', url: pendente.url, novo: false, valor: pendente.valorCentavos / 100, venceEm: pendente.venceEm, copiaECola: copiaEColaValido(pendente.url) },
        };
      }

      // Teto do dia da CLÍNICA (últimas 24 h): só conta o que é NOVO, reaproveitar não gasta.
      const criadosHoje = await banco.count({ where: { clinica, criadoEm: { gte: new Date(agora.getTime() - 86_400_000) } } });
      if (criadosHoje >= TETO_LINKS_POR_UNIDADE_DIA) {
        logger.warn({ unit: unit.slug, clinica, criadosHoje, teto: TETO_LINKS_POR_UNIDADE_DIA }, 'sinal-pix: teto de links por dia atingido');
        return { tipo: 'pronto', resultado: { tipo: 'falhou', motivo: 'teto', detalhe: `${criadosHoje} links nas últimas 24 h (teto ${TETO_LINKS_POR_UNIDADE_DIA})` } };
      }
      const reserva = await banco.create({
        data: { unitId: unit.id, clinica, leadId: String(leadId), linkId: `reserva:${randomUUID()}`, url: '', valorCentavos: centavos as number, venceEm, consultaEm: quando ?? `${venceEm}T23:59`, status: 'criando' },
      });
      return { tipo: 'reservado', reserva };
    });

  let f: Fase1 = await fase1();
  // outra geração do MESMO paciente em curso (retry da ferramenta, outra unidade, outra instância): espera o link dela em vez de criar o seu
  for (let voltas = 0; f.tipo === 'espera'; voltas++) {
    if (voltas >= ESPERA_MAXIMA_VOLTAS) return { tipo: 'falhou', motivo: 'em-andamento', detalhe: 'outra geração do mesmo sinal não terminou' };
    await esperar(1000);
    f = await fase1();
  }
  if (f.tipo === 'pronto') return f.resultado;
  const reserva = f.reserva;
  const venceEm = reserva.venceEm;
  const largar = () => deps.banco.deleteMany({ where: { id: reserva.id } }).catch((err: unknown) => logger.warn({ err: String(err), reserva: reserva.id }, 'sinal-pix: não consegui largar a reserva'));

  // Fase 2 (fora da trava): a chave do Asaas da CLÍNICA e o link.
  const conta = await deps.chave({ id: unit.id, slug: unit.slug }).catch(() => null);
  if (!conta) {
    await largar();
    return { tipo: 'falhou', motivo: 'sem-chave', detalhe: 'a unidade não tem chave do Asaas no cofre' };
  }
  const valor = (centavos as number) / 100;

  // Pix COPIA-E-COLA de valor fixo (11/11/2026, pedido do João: "pensa num idoso"): sem formulário, cola no app do banco e paga.
  if (deps.ler) {
    let pix: { id?: unknown; payload?: unknown } | null;
    try {
      const chaves = await deps.ler<{ data?: Array<{ key?: string; status?: string; type?: string }> }>(conta.unitId, conta.chave, '/pix/addressKeys', { status: 'ACTIVE', limit: 20 });
      const chavePix = (chaves?.data ?? []).find((k) => k.key && (!k.status || k.status === 'ACTIVE'))?.key;
      if (!chavePix) throw new Error('a conta do Asaas não tem chave Pix ativa');
      pix = await deps.escrever<{ id?: unknown; payload?: unknown }>(conta.unitId, conta.chave, 'POST', '/pix/qrCodes/static', {
        addressKey: chavePix,
        value: valor,
        // o Asaas aceita até 37 caracteres; o nome da clínica vem sem "Doutor Hérnia" (nomeDaClinica)
        description: `Sinal da consulta - ${nomeDaClinica(unit.name)}`.slice(0, 37),
        format: 'PAYLOAD',
        allowsMultiplePayments: false,
        // vale até o fim da véspera da consulta (horário de Brasília, o da conta)
        expirationDate: `${venceEm} 23:59:59`,
        externalReference: `sofia-sinal:${unit.slug}:${leadId}`.slice(0, 100),
      });
    } catch (err) {
      const detalhe = err instanceof Error ? err.message : String(err);
      logger.warn({ unit: unit.slug, leadId, detalhe }, 'sinal-pix: o Asaas não criou o Pix copia-e-cola');
      await largar();
      return { tipo: 'falhou', motivo: 'asaas', detalhe: detalhe.slice(0, 300) };
    }
    const qrId = typeof pix?.id === 'string' || typeof pix?.id === 'number' ? String(pix.id) : '';
    const payload = typeof pix?.payload === 'string' ? pix.payload.trim() : '';
    if (!qrId || !copiaEColaValido(payload)) {
      logger.warn({ unit: unit.slug, leadId, qrId: qrId || null }, 'sinal-pix: resposta do Asaas sem id ou sem copia-e-cola válido');
      await largar();
      return { tipo: 'falhou', motivo: 'asaas', detalhe: 'resposta do Asaas sem id ou sem copia-e-cola válido' };
    }
    let registradoPix = true;
    try {
      const r = await deps.banco.updateMany({ where: { id: reserva.id }, data: { linkId: qrId, url: payload, status: 'pendente' } });
      if (r.count !== 1) throw new Error('a reserva sumiu');
    } catch (err) {
      registradoPix = false;
      logger.error({ err: String(err), unit: unit.slug, leadId, qrId }, 'sinal-pix: Pix criado no Asaas mas NÃO gravado no banco — sem baixa automática');
    }
    logger.info({ unit: unit.slug, clinica, leadId, qrId, venceEm }, 'sinal-pix: Pix copia-e-cola criado');
    return { tipo: 'link', url: payload, novo: true, valor, venceEm, registrado: registradoPix, copiaECola: true };
  }

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
    await largar();
    return { tipo: 'falhou', motivo: 'asaas', detalhe: detalhe.slice(0, 300) };
  }
  const linkId = typeof criado?.id === 'string' || typeof criado?.id === 'number' ? String(criado.id) : '';
  if (!linkId || !urlDoAsaasValida(criado?.url)) {
    logger.warn({ unit: unit.slug, leadId, linkId: linkId || null }, 'sinal-pix: resposta do Asaas sem id ou sem url válida');
    await largar();
    return { tipo: 'falhou', motivo: 'asaas', detalhe: 'resposta do Asaas sem id ou sem link válido' };
  }

  // Guarda. Se o banco falhar o link já existe no Asaas: o paciente ainda pode pagar (sem baixa automática) e o log deixa o rastro.
  let registrado = true;
  try {
    const r = await deps.banco.updateMany({ where: { id: reserva.id }, data: { linkId, url: criado.url, status: 'pendente' } });
    if (r.count !== 1) throw new Error('a reserva sumiu');
  } catch (err) {
    registrado = false;
    logger.error({ err: String(err), unit: unit.slug, leadId, linkId }, 'sinal-pix: link criado no Asaas mas NÃO gravado no banco — sem baixa automática');
  }
  logger.info({ unit: unit.slug, clinica, leadId, linkId, venceEm }, 'sinal-pix: link criado');
  return { tipo: 'link', url: criado.url, novo: true, valor, venceEm, registrado };
}

/**
 * Remarcação não é consulta nova: o sinal (pendente ou pago) segue valendo, com a data nova. Só move o que ainda é de uma consulta que não passou
 * (o paciente que faltou e marca de novo recomeça: sinal novo). Chamado por `agendar_consulta` quando é o passo de criar da `remarcar_consulta`.
 */
export async function acompanharRemarcacao(
  unit: { slug: string; spineTimezone?: string | null; businessHoursTimezone?: string | null },
  leadId: number,
  novoQuando: string,
  banco: BancoDoSinal = prisma.sinalPix as unknown as BancoDoSinal,
  agora: Date = new Date(),
): Promise<number> {
  const fuso = fusoDoSinal(unit);
  const agoraLocal = instanteLocal(agora, fuso);
  const desde = new Date(agora.getTime() - VALIDADE_DO_SINAL_DIAS * 86_400_000);
  const linhas = await banco.findMany({ where: { clinica: unidadeDona(unit.slug), leadId: String(leadId), status: { in: ['pago', 'pendente'] }, criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' } });
  let n = 0;
  for (const l of linhas) {
    if (l.consultaEm < agoraLocal || l.consultaEm === novoQuando) continue;
    n += (await banco.updateMany({ where: { id: l.id }, data: { consultaEm: novoQuando } })).count;
  }
  return n;
}
