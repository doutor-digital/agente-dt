/**
 * GET /api/relatorios/mensal-rede — a parte da FRANQUIA e do CUSTO DE WHATSAPP do relatório mensal de CRM.
 *
 * SÓ LEITURA. Não envia nada, não grava campo, não move cartão. Chama a franquia (agenda e tratamentos)
 * e lê as tabelas de custo da Meta que o sincronizador diário já preenche.
 *
 * Query:
 *   mes=AAAA-MM       obrigatório. Ex.: 2026-09
 *   unidades=a,b      só estas (slugs). Padrão: toda unidade ativa com franquia. Dá para chamar de pouco em
 *                     pouco: a franquia limita ritmo, e a rede inteira leva alguns minutos.
 *   cambio=5.45       opcional: cotação USD→BRL para o custo do WhatsApp sair também em reais.
 *
 * Entra com a chave de serviço (`x-internal-key`), montada ACIMA do `requireAuth` em api.routes.ts —
 * senão o 401 global chega antes de alguém olhar a chave.
 *
 * Resposta: { mes, de, ate, geradoEm, unidades[], whatsapp[], semFranquia[], saude }.
 * Uma unidade que a franquia não respondeu aparece com `franquia.ok = false` e o motivo; o resto segue.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { instanteNoFuso, searchSchedules, searchTreatments, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { SEMPRE_FORA, SUFIXO_DE_CONTA_COMPARTILHADA, unidadesDoRelatorio } from './relatorio-rede.controller.js';
import {
  fechamentoPosAvaliacao,
  intervaloDoMes,
  janelas,
  medirAderencia,
  mesValido,
  resumirAgenda,
  resumirTratamentos,
  resumirIa,
  resumirWhatsapp,
  somarDias,
} from '../lib/relatorio-mensal-rede.js';
import { usoDaIaPorConta } from '../services/custo-ia.service.js';

const TZ_PADRAO = 'America/Sao_Paulo';
/** Para medir "sumindo" precisamos de sessões de antes do mês: a escada de faltas olha para trás. */
const DIAS_ANTES_PARA_ADERENCIA = 60;
/** Quanto depois do mês ainda contamos tratamento aberto como "fechou depois da avaliação". */
const DIAS_DEPOIS_PARA_FECHAMENTO = 30;
const SIMULTANEAS = 2;
const PAUSA_MS = 400;
/** A agenda para de ler em 40 páginas de 100 (spine.service). Chegar nisso = a lista pode estar cortada. */
const LIMITE_PAGINAS = 40;

/** Uma execução por vez para o mesmo pedido: repetir a chamada (timeout do cliente) dobraria a carga na franquia. */
const emAndamento = new Set<string>();

const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function agendaEntre(unit: Unit, de: string, ate: string): Promise<{ ok: boolean; schedules: SpineSchedule[]; error?: string; cortada: boolean }> {
  const todas: SpineSchedule[] = [];
  let cortada = false;
  const lista = janelas(de, ate);
  for (let i = 0; i < lista.length; i++) {
    const j = lista[i];
    const r = await searchSchedules(unit, { initialDate: j.de, endDate: j.ate, rowsPerPage: 100 });
    if (!r.ok) return { ok: false, schedules: todas, error: r.error, cortada };
    todas.push(...(r.data?.schedules ?? []));
    if ((r.data?.pages ?? 0) >= LIMITE_PAGINAS) cortada = true;
    if (i < lista.length - 1) await dorme(PAUSA_MS);
  }
  return { ok: true, schedules: todas, cortada };
}

async function unidadeDaFranquia(unit: Unit, mes: string) {
  const { de, ate } = intervaloDoMes(mes);
  const tz = (unit.spineTimezone as string | null) || TZ_PADRAO;
  const hoje = instanteNoFuso(new Date(), tz).slice(0, 10);
  if (de > hoje) return { ok: false as const, error: 'mês ainda não começou na clínica' };
  const corte = ate < hoje ? ate : hoje; // mês corrente: "sumindo" é medido até hoje

  // o mês e a janela anterior (aderência) não dependem um do outro: vão juntos
  const [mesAgenda, antes] = await Promise.all([
    agendaEntre(unit, de, ate),
    agendaEntre(unit, somarDias(de, -DIAS_ANTES_PARA_ADERENCIA), somarDias(de, -1)),
  ]);
  if (!mesAgenda.ok) return { ok: false as const, error: `agenda: ${mesAgenda.error ?? 'sem resposta'}` };

  const fimTrat = somarDias(ate, DIAS_DEPOIS_PARA_FECHAMENTO);
  const trat = await searchTreatments(unit, { de, ate: fimTrat < hoje ? fimTrat : hoje });
  const tratamentos: SpineTreatment[] = trat.ok ? (trat.data?.treatments ?? []) : [];

  return {
    ok: true as const,
    agenda: resumirAgenda(mesAgenda.schedules),
    tratamentos: trat.ok ? resumirTratamentos(tratamentos, de, ate, tz) : null,
    fechamento: trat.ok ? fechamentoPosAvaliacao(mesAgenda.schedules, tratamentos, tz) : null,
    // se a janela anterior falhou, a aderência sai só com o mês (mais curta) e avisa
    aderencia: medirAderencia([...antes.schedules, ...mesAgenda.schedules], corte),
    avisos: [
      ...(mesAgenda.cortada ? ['agenda do mês pode estar CORTADA (chegou ao teto de páginas): contagens podem estar abaixo do real'] : []),
      ...(trat.ok ? [] : [`tratamentos: ${trat.error ?? 'sem resposta'}`]),
      ...(antes.ok ? [] : [`aderência medida só com o mês: ${antes.error ?? 'janela anterior sem resposta'}`]),
    ],
  };
}

export async function relatorioMensalRedeHandler(req: Request, res: Response): Promise<void> {
  const inicio = Date.now();
  const mes = req.query.mes;
  if (!mesValido(mes)) {
    res.status(400).json({ error: 'mes_invalido', esperado: 'AAAA-MM' });
    return;
  }
  const pedidas = typeof req.query.unidades === 'string' && req.query.unidades.trim()
    ? req.query.unidades.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const cambioBruto = typeof req.query.cambio === 'string' ? Number(req.query.cambio.replace(',', '.')) : NaN;
  const cambio = Number.isFinite(cambioBruto) && cambioBruto > 0 ? cambioBruto : null;
  const { de, ate } = intervaloDoMes(mes);

  const chave = `${mes}|${pedidas ? [...pedidas].sort().join(',') : '*'}`;
  if (emAndamento.has(chave)) {
    res.status(429).json({ error: 'em_andamento', dica: 'o mesmo pedido já está rodando; espere terminar (a rede inteira leva alguns minutos)' });
    return;
  }
  emAndamento.add(chave);

  try {
    const { escolhidas, semFranquia } = await unidadesDoRelatorio(pedidas);
    if (!escolhidas.length) {
      res.status(404).json({ error: 'nenhuma_unidade', pedidas });
      return;
    }
    const achadas = new Set(escolhidas.map((u) => u.slug));

    // franquia: poucas por vez, para não estourar o ritmo da API
    const unidades: Array<Record<string, unknown>> = new Array(escolhidas.length);
    let proxima = 0;
    const trabalhador = async () => {
      for (;;) {
        const i = proxima++;
        if (i >= escolhidas.length) return;
        const u = escolhidas[i];
        try {
          unidades[i] = { slug: u.slug, nome: u.name, franquia: await unidadeDaFranquia(u, mes) };
        } catch (err) {
          logger.warn({ err, slug: u.slug }, 'relatorio-mensal-rede: unidade falhou');
          unidades[i] = { slug: u.slug, nome: u.name, franquia: { ok: false, error: (err as Error).message } };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SIMULTANEAS, escolhidas.length) }, trabalhador));

    // Custo de WhatsApp: as mesmas regras de elegibilidade do relatório (sem conta de teste, sem unidade que
    // divide conta com outra) e UMA linha por WABA — duas unidades no mesmo WABA somariam o gasto em dobro.
    // Entram também as sem franquia: o custo de mensagem existe independente da agenda.
    const ativas = await prisma.unit.findMany({
      where: { isActive: true },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, name: true, metaWabaId: true, metaMonthlyBudgetUsd: true },
    });
    const vistosWaba = new Set<string>();
    const elegiveis = ativas
      .filter((u) => !SEMPRE_FORA.has(u.slug) && !SUFIXO_DE_CONTA_COMPARTILHADA.test(u.slug))
      .filter((u) => !pedidas || pedidas.includes(u.slug))
      .filter((u) => {
        if (!u.metaWabaId) return true;
        if (vistosWaba.has(u.metaWabaId)) return false;
        vistosWaba.add(u.metaWabaId);
        return true;
      });
    const ids = elegiveis.map((u) => u.id);
    const janela = { gte: new Date(`${de}T00:00:00.000Z`), lte: new Date(`${ate}T00:00:00.000Z`) };
    const [custos, templates] = await Promise.all([
      prisma.whatsappCostDaily.findMany({ where: { unitId: { in: ids }, date: janela } }),
      prisma.whatsappTemplateDaily.findMany({ where: { unitId: { in: ids }, date: janela } }),
    ]);
    const whatsapp: Array<Record<string, unknown>> = [];
    for (const u of elegiveis) {
      const c = custos.filter((x) => x.unitId === u.id);
      const t = templates.filter((x) => x.unitId === u.id);
      if (!c.length && !t.length) continue;
      whatsapp.push({
        slug: u.slug,
        nome: u.name,
        waba: u.metaWabaId,
        orcamentoMensalUsd: u.metaMonthlyBudgetUsd ?? null,
        ...resumirWhatsapp(c, t, cambio),
      });
    }

    // custo da IA por conta Kommo (clínica): soma as unidades irmãs. Falha aqui não derruba o resto do relatório.
    let ia: Array<Record<string, unknown>> = [];
    let avisoIa: string | null = null;
    try {
      const uso = await usoDaIaPorConta(de, ate);
      ia = uso.map((u) => ({ conta: u.conta, slugs: u.slugs, ...resumirIa(u, cambio) }));
    } catch (err) {
      logger.warn({ err }, 'relatorio-mensal-rede: custo da IA falhou');
      avisoIa = 'custo da IA indisponível (consulta ao banco falhou)';
    }
    for (const u of unidades) {
      const un = escolhidas.find((e) => e.slug === u.slug);
      const conta = un?.kommoSubdomain ?? un?.slug;
      u.ia = ia.find((x) => x.conta === conta) ?? null;
    }

    const falhas = unidades.filter((u) => !(u.franquia as { ok: boolean }).ok).length;
    const ignoradas = (pedidas ?? []).filter((slug) => !achadas.has(slug) && !elegiveis.some((u) => u.slug === slug));
    res.json({
      mes,
      de,
      ate,
      geradoEm: new Date().toISOString(),
      unidades,
      whatsapp,
      ia,
      avisoIa,
      semFranquia,
      // slugs pedidos que não existem ou não são elegíveis: sem isto, um erro de digitação some em silêncio
      ignoradas,
      saude: { unidades: unidades.length, falhas, completo: falhas === 0 && ignoradas.length === 0, segundos: Math.round((Date.now() - inicio) / 1000) },
    });
  } catch (err) {
    logger.error({ err }, 'relatorio-mensal-rede: falhou');
    res.status(500).json({ error: 'relatorio_falhou' });
  } finally {
    emAndamento.delete(chave);
  }
}
