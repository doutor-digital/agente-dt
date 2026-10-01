/**
 * GET /api/relatorios/rede-diaria — o relatório das 18h da rede, pronto para o n8n mandar.
 *
 * SÓ LEITURA. Não envia WhatsApp, não grava campo, não move cartão. Devolve o texto e os números;
 * quem decide mandar (e para quem) é o n8n, depois de a pessoa aprovar o texto. Por isso dá para
 * chamar à vontade durante o teste: não tem efeito colateral fora as chamadas de leitura à franquia
 * e ao Kommo.
 *
 * Query:
 *   data=AAAA-MM-DD   dia a relatar. Padrão: hoje na clínica. Útil para conferir um dia passado.
 *   unidades=a,b      só estas (slugs). Padrão: toda unidade ativa com a franquia ligada.
 *   formato=texto     devolve só o texto puro, para ler no terminal/navegador.
 *
 * Entra com a chave de serviço (`x-internal-key`), igual ao cérebro e à faxina — montada ACIMA do
 * `requireAuth` global em api.routes.ts, senão o 401 chega antes de alguém olhar a chave.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import type { LeadDoKommo } from '../lib/relatorio-rede-analise.js';
import { instanteNoFuso, localParaUtcIso, searchSchedules, searchTreatments } from '../services/spine.service.js';
import {
  coletarRede,
  dataValida,
  montarResposta,
  type Fontes,
  type UnidadeParaColeta,
} from '../lib/relatorio-rede.js';

const TZ_PADRAO = 'America/Sao_Paulo';

/** Conta de teste e unidade que não é Doutor Hérnia: nunca entram no relatório da chefe. */
export const SEMPRE_FORA = new Set(['default', 'laboratorio-kommo']);

/** `imperatriz-resgate` e cia. dividem a conta da `doutor-hernia-imperatriz`: contar os dois dobraria. */
export const SUFIXO_DE_CONTA_COMPARTILHADA = /-(resgate|tratamento|financeiro)$/;

const somarDias = (aaaammdd: string, n: number) => new Date(Date.parse(`${aaaammdd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Teto de páginas de 250: criados em 7 dias cabem folgado; mexidos em 7 dias é a lista grande. */
const PAGINAS_CRIADOS = 8;
const PAGINAS_MEXIDOS = 12;

const fontesReais: Fontes = {
  async agenda(u, de, ate) {
    const r = await searchSchedules(u as unknown as Unit, { initialDate: de, endDate: ate, rowsPerPage: 100 });
    return { ok: r.ok, schedules: r.data?.schedules, error: r.error };
  },
  async tratamentos(u, hoje) {
    // Só o dia pedido: "fechado hoje" olha tratamento criado nesse dia. Janela explícita também faz o
    // relatório de um dia passado funcionar (antes era sempre o último mês a partir de agora).
    const r = await searchTreatments(u as unknown as Unit, { de: somarDias(hoje, -1), ate: hoje });
    return { ok: r.ok, treatments: r.data?.treatments, error: r.error };
  },
  async kommo(u, j) {
    const unit = u as unknown as Unit;
    if (!unit.kommoSubdomain || !unit.kommoAccessToken) return null;   // sem Kommo não é falha: só não tem análise
    const kommo = createKommoClient(unit);
    // Em sequência, não em paralelo: é a mesma conta, e rajada no Kommo já bloqueou o IP da VPS.
    const esquema = await esquemaDaUnidade(unit, kommo);
    const mexidos = await kommo.listLeadsNaJanela('updated_at', j.mexidosDe, Math.floor(Date.now() / 1000), PAGINAS_MEXIDOS);
    const doMexido = (l: { created_at?: number }) => (l.created_at ?? 0) >= j.criadosDe && (l.created_at ?? 0) <= j.criadosAte;
    // Todo lead criado na janela foi mexido na janela (criar conta como mexer). Se a lista de mexidos
    // veio inteira, os criados saem dela; só quando ela foi cortada vale a segunda chamada.
    const criados = mexidos.truncado
      ? await kommo.listLeadsNaJanela('created_at', j.criadosDe, j.criadosAte, PAGINAS_CRIADOS)
      : { leads: mexidos.leads.filter(doMexido), truncado: false };
    return {
      criados: criados.leads as unknown as LeadDoKommo[],
      mexidos: mexidos.leads as unknown as LeadDoKommo[],
      acha: esquema.campoPorNome,
      truncado: criados.truncado || mexidos.truncado,
    };
  },
  dia(u, iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return instanteNoFuso(d, (u.spineTimezone as string | null) || TZ_PADRAO).slice(0, 10);
  },
  calendario(u, data) {
    const tz = (u.spineTimezone as string | null) || TZ_PADRAO;
    const hoje = data ?? instanteNoFuso(new Date(), tz).slice(0, 10);
    const amanha = somarDias(hoje, 1);
    const inicioJanela = somarDias(hoje, -6);
    const unix = (dia: string) => {
      const iso = localParaUtcIso(`${dia}T00:00:00`, tz);
      return iso ? Math.floor(Date.parse(iso) / 1000) : 0;
    };
    return { hoje, amanha, deUnix: unix(hoje), ateUnix: unix(amanha) - 1, inicioJanela, janelaDeUnix: unix(inicioJanela) };
  },
};

/** As unidades que entram: ativas, com franquia e Kommo, uma por conta. */
export async function unidadesDoRelatorio(pedidas: string[] | null) {
  const todas = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { slug: 'asc' } });
  const candidatas = todas.filter((u) => !SEMPRE_FORA.has(u.slug));

  const comFranquia = candidatas.filter((u) => u.spineEnabled && u.spineToken && !SUFIXO_DE_CONTA_COMPARTILHADA.test(u.slug));
  // uma linha por franquia: duas unidades com o mesmo token são a mesma clínica
  const vistos = new Set<string>();
  const unicas = comFranquia.filter((u) => {
    const k = u.spineToken as string;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  const escolhidas = pedidas ? unicas.filter((u) => pedidas.includes(u.slug)) : unicas;
  const semFranquia = candidatas
    .filter((u) => !u.spineEnabled || !u.spineToken)
    .filter((u) => !SUFIXO_DE_CONTA_COMPARTILHADA.test(u.slug))
    .map((u) => u.name);
  return { escolhidas, semFranquia };
}

export async function relatorioRedeDiariaHandler(req: Request, res: Response): Promise<void> {
  const inicio = Date.now();
  const data = dataValida(req.query.data) ? req.query.data : undefined;
  if (typeof req.query.data === 'string' && !data) {
    res.status(400).json({ error: 'data_invalida', esperado: 'AAAA-MM-DD' });
    return;
  }
  const pedidas = typeof req.query.unidades === 'string' && req.query.unidades.trim()
    ? req.query.unidades.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  try {
    const { escolhidas, semFranquia } = await unidadesDoRelatorio(pedidas);
    if (!escolhidas.length) {
      res.status(404).json({ error: 'nenhuma_unidade', pedidas, dica: 'confira os slugs em /api/cerebro/unidades' });
      return;
    }
    const unidades = await coletarRede(escolhidas as unknown as UnidadeParaColeta[], fontesReais, {
      data,
      simultaneas: 2,
      pausaMs: 400,
      // o Kommo agora traz 2 listas por unidade (a de mexidos pode ter vários milhares)
      limiteUnidadeMs: 120_000,
    });
    // a data do cabeçalho é a da primeira unidade: todas estão no mesmo fuso, salvo exceção
    const cal = fontesReais.calendario(escolhidas[0] as unknown as UnidadeParaColeta, data);
    const resposta = montarResposta({ data: cal.hoje, inicioJanela: cal.inicioJanela, unidades, semFranquia: pedidas ? [] : semFranquia, inicioMs: inicio, porUnidade: req.query.porUnidade === '1' || req.query.porUnidade === 'true' });

    logger.info(
      { unidades: unidades.length, falhas: resposta.saude.falhas, semFranquia: semFranquia.length, ms: resposta.duracaoMs },
      'relatório da rede gerado',
    );

    if (req.query.formato === 'texto') {
      res.type('text/plain; charset=utf-8').send(resposta.texto);
      return;
    }
    res.json(resposta);
  } catch (err) {
    logger.error({ err: String(err) }, 'relatório da rede falhou');
    res.status(500).json({ error: 'relatorio_falhou', detalhe: String(err).slice(0, 200) });
  }
}
