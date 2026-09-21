import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { gravarCampoDigital, limparCampoDigital } from '../services/lead-metrics.service.js';

/**
 * Revisão dentro do próprio Kommo (decisão do João, 21/09/2026): em vez de tarefa ou lista no relatório,
 * o lead com cartão errado ganha a etiqueta abaixo e o motivo no campo do bloco DIGITAL. A SDR filtra a
 * lista pela etiqueta; o relatório das 20h leva só a contagem e o link. Quando corrige, tudo sai sozinho.
 */
export const TAG_REVISAR_CARTAO = '⚠ Revisar cartão';
export const CAMPO_PENDENCIA_CARTAO = '⚠ Pendência do cartão';

const SWEEP_MS = 5 * 60_000;
const LOOKBACK_MIN = 12;
const CTX_TTL_MS = 30 * 60_000;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export const NOMES_CAMPO = {
  AGENDOU: '✓ Agendou',
  TIPO_AGENDAMENTO: '⬢ Tipo de agendamento',
  SITUACAO_CONSULTA: '✓ Situação da consulta',
  FECHOU_TRAT: '✓ Fechou tratamento',
  TRAT_FECHADO: '⚕ Tratamento fechado',
  FORMA_PAGAMENTO: '⬢ Forma de pagamento',
  MOTIVO_NAO_AGEND: '⊘ Motivo do não agendamento',
  MOTIVO_NAO_FECH: '⊘ Motivo de não fechamento do tratamento',
  COMPARECEU_ULT: '✓ Compareceu à última sessão marcada',
  PG_ANTECIPADO: '✓ Consulta pg antecipado',
  DATA_CANCEL: '◷ Data do cancelamento',
  MOTIVO_CANCEL_TRAT: '⊘ Motivo do cancelamento do tratamento',
  AGENDADO_SDR_EM: '◷ Agendado pela SDR em',
  DATA_CONSULTA: '◷ Data da Consulta',
  // Campos do fluxograma operacional: o semáforo é a leitura comercial do
  // desfecho da consulta, e sem ele o relatório das 20h não fecha.
  SEMAFORO: '◉ Semáforo',
  TRAT_INDICADO: '⚕ Tratamento indicado',
  VALOR_TRAT: '¤ Valor do tratamento',
  ORIGEM: '⚑ Origem',
  DATA_RETORNO: '◷ Data de retorno',
  DATA_RETORNO_EXAMES: '◷ Data de retorno com exames',
} as const;

export type ChaveCampo = keyof typeof NOMES_CAMPO;

export interface ContextoUnidade {
  campos: Record<ChaveCampo, number[]>;
  camposLigacao: Set<number>;
  pipeComercial: number | null;
  pipeTratamento: number | null;
  stAgendado: number | null;
  stCompareceu: number | null;
}

export function soMudancasIgnoradas(
  eventos: Array<{ type?: string }>,
  camposIgnorados: Set<number>,
): boolean {
  if (eventos.length === 0) return false;
  return eventos.every((e) => {
    const m = /^custom_field_(\d+)_value_changed$/.exec(e.type ?? '');
    return !!m && camposIgnorados.has(Number(m[1]));
  });
}

const GANHO = 142;
const PERDIDO = 143;

const cache = new Map<string, { ctx: ContextoUnidade; expiraEm: number }>();

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function montarContexto(
  campos: Array<{ id: number; name: string }>,
  pipelines: Array<{ id: number; name: string; statuses: Array<{ id: number; name: string }> }>,
): ContextoUnidade {
  const porNome = new Map<string, number[]>();
  for (const c of campos) {
    const k = normalizar(c.name);
    porNome.set(k, [...(porNome.get(k) ?? []), c.id]);
  }
  const resolvido = {} as Record<ChaveCampo, number[]>;
  for (const [chave, nome] of Object.entries(NOMES_CAMPO) as Array<[ChaveCampo, string]>) {
    resolvido[chave] = porNome.get(normalizar(nome)) ?? [];
  }

  const acharPipe = (nome: string) =>
    pipelines.find((p) => normalizar(p.name) === normalizar(nome))?.id ?? null;
  const comercial = pipelines.find((p) => normalizar(p.name) === normalizar('COMERCIAL'));
  const stAgendado =
    comercial?.statuses.find((s) => normalizar(s.name) === normalizar('AGENDADO'))?.id ?? null;
  const stCompareceu =
    comercial?.statuses.find((s) => normalizar(s.name) === normalizar('COMPARECEU'))?.id ?? null;

  return {
    campos: resolvido,
    camposLigacao: new Set(campos.filter((c) => c.name.trim().startsWith('☎')).map((c) => c.id)),
    pipeComercial: acharPipe('COMERCIAL'),
    pipeTratamento: acharPipe('TRATAMENTO'),
    stAgendado,
    stCompareceu,
  };
}

async function contextoDaUnidade(unit: Unit, kommo: KommoClient): Promise<ContextoUnidade> {
  const guardado = cache.get(unit.id);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.ctx;

  const [brutoCampos, pipelines] = await Promise.all([
    kommo.listLeadCustomFields(),
    kommo.listPipelines(),
  ]);
  const campos =
    (brutoCampos as { _embedded?: { custom_fields?: Array<{ id: number; name: string }> } })?._embedded
      ?.custom_fields ?? [];
  const ctx = montarContexto(
    campos,
    pipelines.map((p) => ({ id: p.id, name: p.name, statuses: p.statuses ?? [] })),
  );
  cache.set(unit.id, { ctx, expiraEm: Date.now() + CTX_TTL_MS });
  return ctx;
}

function vals(lead: KommoLead, ids: number[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === id);
    for (const v of cf?.values ?? []) {
      const s = String((v as { value?: unknown }).value ?? '').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export interface Leitor {
  vazio: (c: ChaveCampo) => boolean;
  igual: (c: ChaveCampo, v: string) => boolean;
  contem: (c: ChaveCampo, v: string) => boolean;
  data: (c: ChaveCampo) => number | null;
}

function leitor(lead: KommoLead, ctx: ContextoUnidade): Leitor {
  const ler = (c: ChaveCampo) => vals(lead, ctx.campos[c]);
  return {
    vazio: (c) => ler(c).length === 0,
    igual: (c, v) => ler(c).some((x) => x.toLowerCase() === v.toLowerCase()),
    // O semáforo guarda a cor e a explicação juntas ("LARANJA — não fechou:
    // falta exame"), então comparar por igualdade nunca casaria.
    contem: (c, v) => ler(c).some((x) => x.toLowerCase().includes(v.toLowerCase())),
    data: (c) => {
      const bruto = ler(c)[0];
      if (!bruto) return null;
      const n = Number(bruto);
      return Number.isFinite(n) && n > 0 ? n : null;
    },
  };
}

export interface Regra {
  key: string;
  aplica: (l: KommoLead, ctx: ContextoUnidade) => boolean;
  erro: (r: Leitor, l: KommoLead) => string | null;
}

const emComercial = (l: KommoLead, ctx: ContextoUnidade, status: number | null) =>
  ctx.pipeComercial !== null && l.pipeline_id === ctx.pipeComercial && l.status_id === status;

export const REGRAS_CARD: Regra[] = [
  {
    key: 'A_agendado_incompleto',
    aplica: (l, ctx) => emComercial(l, ctx, ctx.stAgendado),
    erro: (r) => {
      const p: string[] = [];
      if (r.igual('AGENDOU', 'Não')) p.push('"✓ Agendou" = Não');
      if (r.vazio('TIPO_AGENDAMENTO')) p.push('"Tipo de agendamento" vazio');
      if (r.vazio('SITUACAO_CONSULTA')) p.push('"Situação da consulta" vazia');
      return p.length ? 'está em AGENDADO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'A2_data_agendamento_invalida',
    aplica: (l, ctx) => emComercial(l, ctx, ctx.stAgendado),
    erro: (r) => {
      const agendadoEm = r.data('AGENDADO_SDR_EM');
      if (agendadoEm === null) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" está vazio — o agendamento não entra no relatório do dia';
      }
      const consulta = r.data('DATA_CONSULTA');
      const agora = Math.floor(Date.now() / 1000);
      if (agendadoEm > agora + 86_400) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" tem data FUTURA — esse campo é quando a SDR agendou, não a data da consulta';
      }
      if (consulta !== null && agendadoEm === consulta) {
        return 'está em AGENDADO mas "◷ Agendado pela SDR em" está igual à "◷ Data da Consulta" — o primeiro é quando agendou, o segundo é quando o paciente vem';
      }
      return null;
    },
  },
  {
    // O paciente foi atendido e saiu com tratamento indicado, mas ninguém disse
    // se fechou, se ficou de pensar ou se não era caso. Sem o semáforo, esse
    // atendimento não existe no relatório das 20h — nem como venda, nem como
    // perda. É o buraco mais caro do dia, porque some justamente quem já veio.
    key: 'G_compareceu_sem_semaforo',
    // Amarrada à SITUAÇÃO DA CONSULTA, não à etapa. O card não fica parado em
    // COMPARECEU — medido na Imperatriz, a etapa tem ZERO leads, então a regra
    // presa a ela nunca dispararia. Pela situação ela encontra 69 pacientes que
    // vieram, saíram com indicação, e cujo desfecho ninguém registrou.
    aplica: (l, ctx) => ctx.pipeComercial !== null,
    erro: (r) => {
      if (!r.contem('SITUACAO_CONSULTA', 'atendido')) return null;
      if (r.vazio('TRAT_INDICADO')) return null;
      if (!r.vazio('SEMAFORO')) return null;
      return 'foi atendido e tem tratamento indicado, mas o "◉ Semáforo" está vazio — sem ele o desfecho não entra no relatório do dia, nem como venda nem como perda';
    },
  },
  {
    // Fechou e ninguém lançou o valor. O tratamento aparece como vendido e o
    // financeiro não bate — e a diferença só aparece no fim do mês.
    key: 'H_fechou_sem_valor',
    aplica: (l, ctx) => ctx.pipeComercial !== null || ctx.pipeTratamento !== null,
    erro: (r) => {
      if (!r.igual('FECHOU_TRAT', 'Sim')) return null;
      if (!r.vazio('VALOR_TRAT')) return null;
      return 'está com "✓ Fechou tratamento = Sim" mas sem "¤ Valor do tratamento" — o tratamento conta como vendido e o financeiro não fecha';
    },
  },
  {
    // Laranja quer dizer "não fechou porque falta exame". Se ninguém marcar o
    // retorno, o paciente simplesmente some — e era um caso vivo, não perdido.
    key: 'I_laranja_sem_retorno',
    aplica: (l, ctx) => ctx.pipeComercial !== null,
    erro: (r) => {
      if (r.vazio('SEMAFORO')) return null;
      const laranja = ['LARANJA', 'laranja'].some((v) => r.contem('SEMAFORO', v));
      if (!laranja) return null;
      if (!r.vazio('DATA_RETORNO') || !r.vazio('DATA_RETORNO_EXAMES')) return null;
      return 'está LARANJA (falta exame) e não tem data de retorno marcada — sem isso o paciente some do funil';
    },
  },
  // NÃO existe regra "agendado sem origem", e é decisão, não esquecimento.
  // O fluxograma pede o alerta "quando o dado deveria estar disponível" — e hoje
  // ele não está: o campo `origin.ref` do Kommo, que traz a referência do
  // anúncio, vem VAZIO em 100% dos leads, inclusive nas contas com API oficial.
  // Medido: dispararia em 52 dos 120 agendados da Imperatriz, cobrando da
  // secretária um dado que ninguém tem como preencher. Quando o rastreio de
  // anúncio estiver de pé, esta regra passa a fazer sentido.
  {
    key: 'B_ganho_sem_fechamento',
    aplica: (l, ctx) => emComercial(l, ctx, GANHO),
    erro: (r) => {
      const p: string[] = [];
      if (!r.igual('FECHOU_TRAT', 'Sim')) p.push('"Fechou tratamento" não está Sim');
      if (r.vazio('TRAT_FECHADO')) p.push('"Tratamento fechado" vazio');
      if (r.vazio('FORMA_PAGAMENTO')) p.push('"Forma de pagamento" vazia');
      return p.length ? 'está em GANHO mas ' + p.join('; ') : null;
    },
  },
  {
    key: 'C_perdido_sem_motivo',
    aplica: (l, ctx) => emComercial(l, ctx, PERDIDO),
    erro: (r, l) =>
      !l.loss_reason_id && r.vazio('MOTIVO_NAO_AGEND') && r.vazio('MOTIVO_NAO_FECH')
        ? 'está em PERDIDO sem motivo nenhum — nem o do Kommo, nem "Motivo do não agendamento", nem "Motivo de não fechamento"'
        : null,
  },
  {
    key: 'D_noshow_pago',
    aplica: () => true,
    erro: (r) =>
      r.igual('COMPARECEU_ULT', 'Não') && r.igual('PG_ANTECIPADO', 'Sim')
        ? '"Compareceu à última sessão" = Não mas "Consulta pg antecipado" = Sim (no-show pago)'
        : null,
  },
  {
    key: 'F_cancelado_sem_dados',
    aplica: (l, ctx) =>
      ctx.pipeTratamento !== null && l.pipeline_id === ctx.pipeTratamento && l.status_id === PERDIDO,
    erro: (r) => {
      const p: string[] = [];
      if (r.vazio('DATA_CANCEL')) p.push('"Data do cancelamento" vazia');
      if (r.vazio('MOTIVO_CANCEL_TRAT')) p.push('"Motivo do cancelamento" vazio');
      return p.length ? 'está em TRATAMENTO CANCELADO mas ' + p.join('; ') : null;
    },
  },
];

export function avaliarLead(lead: KommoLead, ctx: ContextoUnidade): Array<{ key: string; erro: string }> {
  const r = leitor(lead, ctx);
  const out: Array<{ key: string; erro: string }> = [];
  for (const regra of REGRAS_CARD) {
    if (!regra.aplica(lead, ctx)) continue;
    const erro = regra.erro(r, lead);
    if (erro) out.push({ key: regra.key, erro });
  }
  return out;
}

async function validarUnidade(unit: Unit): Promise<void> {
  const desde = Math.floor((Date.now() - LOOKBACK_MIN * 60_000) / 1000);
  const kommo = createKommoClient(unit);
  const ctx = await contextoDaUnidade(unit, kommo);
  if (ctx.pipeComercial === null || ctx.stAgendado === null) {
    logger.warn({ unit: unit.slug }, 'card-validation: funil COMERCIAL/AGENDADO não resolvido, pulando');
    return;
  }

  const leads = await kommo.listLeadsAtualizadosComCampos(desde, 250);
  if (leads.length === 0) return;

  const existentes = await prisma.cardAlert.findMany({
    where: { unitId: unit.id },
    select: { leadId: true, ruleKey: true },
  });
  const jaAlertado = new Set(existentes.map((e) => `${e.leadId}|${e.ruleKey}`));

  for (const lead of leads) {
    const leadIdStr = String(lead.id);
    const achados = new Map(avaliarLead(lead, ctx).map((a) => [a.key, a.erro]));
    let soLigacao: boolean | null = null;
    const mexeuSoORastreioDeLigacao = async () => {
      if (soLigacao === null) {
        soLigacao = soMudancasIgnoradas(await kommo.eventosDoLead(lead.id, desde), ctx.camposLigacao);
      }
      return soLigacao;
    };

    // 1) card_alert espelha o conjunto ATUAL de pendências. Regra que deixou de aplicar (lead mudou de
    //    etapa/funil) também sai — antes ficava fantasma na contagem (review, 21/09).
    for (const regra of REGRAS_CARD) {
      const chave = `${leadIdStr}|${regra.key}`;
      const erro = regra.aplica(lead, ctx) ? achados.get(regra.key) : undefined;

      if (!erro) {
        achados.delete(regra.key);
        if (jaAlertado.has(chave)) {
          await prisma.cardAlert
            .deleteMany({ where: { unitId: unit.id, leadId: leadIdStr, ruleKey: regra.key } })
            .catch(() => undefined);
          jaAlertado.delete(chave);
        }
        continue;
      }

      if (jaAlertado.has(chave)) continue;
      if (await mexeuSoORastreioDeLigacao()) {
        logger.info(
          { unit: unit.slug, leadId: lead.id, rule: regra.key },
          'card-validation: só o rastreio de ligação mexeu no cartão — sem alerta',
        );
        achados.delete(regra.key);
        continue;
      }

      // Decisão do João (21/09/2026): campo vazio NÃO é tarefa nem nota solta — o lead ganha a etiqueta
      // "⚠ Revisar cartão" e o motivo no campo "⚠ Pendência do cartão" (reconciliado abaixo).
      // Aqui só registramos a pendência por regra, que é o que a contagem do relatório usa.
      try {
        await prisma.cardAlert.create({
          data: { unitId: unit.id, leadId: leadIdStr, ruleKey: regra.key },
        });
        jaAlertado.add(chave);
        logger.info({ unit: unit.slug, leadId: lead.id, rule: regra.key }, 'card-validation: pendência registrada');
      } catch (err) {
        achados.delete(regra.key);
        logger.warn(
          { err: String(err), unit: unit.slug, leadId: lead.id, rule: regra.key },
          'card-validation: falha ao registrar pendência',
        );
      }
    }

    // 2) Etiqueta + motivo reconciliados com o estado REAL do cartão, toda passada: se a Kommo falhou na
    //    anterior (429, incidente), aqui refaz; se o lead já está certo, não escreve nada.
    const pendentes = REGRAS_CARD.map((r) => achados.get(r.key)).filter(Boolean) as string[];
    const temTag = (lead._embedded?.tags ?? []).some((t) => t.name === TAG_REVISAR_CARTAO);
    const textoAtual = String(valorDoCampoPorNome(lead, CAMPO_PENDENCIA_CARTAO) ?? '').trim();
    const textoDesejado = pendentes.join(' · ').slice(0, 250);
    try {
      if (pendentes.length > 0) {
        if (!temTag) await kommo.addTag({ leadId: lead.id, tag: TAG_REVISAR_CARTAO });
        if (textoAtual !== textoDesejado) {
          await gravarCampoDigital(unit, kommo, lead.id, CAMPO_PENDENCIA_CARTAO, 'text', textoDesejado);
        }
        if (!temTag || textoAtual !== textoDesejado) {
          logger.info({ unit: unit.slug, leadId: lead.id, pendencias: pendentes.length }, 'card-validation: etiqueta ⚠ Revisar cartão aplicada');
        }
      } else if (temTag || textoAtual) {
        if (temTag) await kommo.removeTag(lead.id, TAG_REVISAR_CARTAO);
        if (textoAtual) await limparCampoDigital(unit, kommo, lead.id, CAMPO_PENDENCIA_CARTAO);
        logger.info({ unit: unit.slug, leadId: lead.id }, 'card-validation: cartão corrigido — etiqueta removida');
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'card-validation: falha ao marcar/desmarcar revisão no cartão');
    }
  }
}

function valorDoCampoPorNome(lead: KommoLead, nome: string): unknown {
  const campo = (lead.custom_fields_values ?? []).find((v) => v.field_name === nome);
  return campo?.values?.[0]?.value ?? null;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { cardValidationEnabled: true } });
    for (const unit of unidades) {
      await validarUnidade(unit).catch((err) =>
        logger.warn({ err: String(err), unit: unit.slug }, 'card-validation: unidade falhou'),
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'card-validation: varredura falhou');
  } finally {
    rodando = false;
  }
}

export async function seedBaselineUnit(unit: Unit): Promise<{ leads: number; erros: number }> {
  const kommo = createKommoClient(unit);
  const ctx = await contextoDaUnidade(unit, kommo);
  if (ctx.pipeComercial === null || ctx.stAgendado === null) {
    logger.warn({ unit: unit.slug }, 'card-validation: funil não resolvido, baseline abortado');
    return { leads: 0, erros: 0 };
  }
  const leads = await kommo.listLeads(120);
  const rows: Array<{ unitId: string; leadId: string; ruleKey: string }> = [];
  for (const lead of leads) {
    for (const a of avaliarLead(lead, ctx)) {
      rows.push({ unitId: unit.id, leadId: String(lead.id), ruleKey: a.key });
    }
  }
  if (rows.length) {
    await prisma.cardAlert.createMany({ data: rows, skipDuplicates: true });
  }
  logger.info({ unit: unit.slug, leads: leads.length, erros: rows.length }, 'card-validation: baseline semeado');
  return { leads: leads.length, erros: rows.length };
}

export function startCardValidationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('card-validation: worker iniciado (guardado por cardValidationEnabled)');
}

export function stopCardValidationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
