/**
 * `POST /api/public/widget/:slug/copiloto/perguntar`  `{ leadId, pergunta, historico? }`
 *
 * O Copiloto da recepção (v1: SÓ LÊ, EXPLICA E SUGERE — nada aqui grava no Kommo). Lê o cartão e a conversa do
 * Kommo da unidade, tira nome/telefone, pergunta à OpenAI (chave PRÓPRIA do Copiloto) e devolve a resposta e as
 * sugestões de campo que passaram pelo portão (`lib/copiloto/mapa-de-campos.ts`).
 *
 * Porta: a mesma chave por unidade dos widgets (`X-Widget-Key`), com limite por minuto. Só responde para as
 * unidades listadas em COPILOTO_UNIDADES: vazio = desligado em toda a rede.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';
import { createKommoClient, type KommoClient, type KommoLeadCustomField, type KommoPipeline } from '../services/kommo.service.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';
import { recordLlmCall } from '../services/openai.service.js';
import { anonimizar } from '../lib/copiloto/anonimizar.js';
import { montarContextoDoCartao } from '../lib/copiloto/contexto.js';
import { chamarOpenAi } from '../lib/copiloto/openai.js';
import { lerPedido } from '../lib/copiloto/pedido.js';
import { responderAoCopiloto } from '../lib/copiloto/responder.js';

const LIMITE = { balde: 'copiloto', max: 30 };
const CACHE_DO_KOMMO_MS = 10 * 60_000;
const cacheEstrutura = new Map<string, { em: number; funis: KommoPipeline[]; defs: KommoLeadCustomField[] }>();

async function estruturaDaConta(unit: Unit, kommo: KommoClient) {
  const g = cacheEstrutura.get(unit.id);
  if (g && Date.now() - g.em < CACHE_DO_KOMMO_MS) return g;
  const [funis, defs] = await Promise.all([kommo.listPipelines(), kommo.listLeadCustomFieldsTyped()]);
  const novo = { em: Date.now(), funis, defs };
  cacheEstrutura.set(unit.id, novo);
  return novo;
}

export async function copilotoPerguntarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE);
  if (!unit) return;
  if (!env.COPILOTO_UNIDADES.includes(unit.slug)) {
    res.status(404).json({ error: 'copiloto não liberado para esta unidade' });
    return;
  }
  if (!env.COPILOTO_OPENAI_API_KEY) {
    res.status(503).json({ error: 'copiloto sem chave da IA' });
    return;
  }
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const pedido = lerPedido(req.body);
  if ('erro' in pedido) {
    res.status(400).json({ error: pedido.erro });
    return;
  }

  try {
    const kommo = createKommoClient(unit);
    const conversaBruta = mensagensOficiais(kommo, pedido.leadId, 40).catch(() => []);
    const [lead, estrutura] = await Promise.all([kommo.getLead(pedido.leadId), estruturaDaConta(unit, kommo)]);
    const contatoId = lead._embedded?.contacts?.find((c) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id;
    const contato = contatoId ? await kommo.getContactBasico(contatoId).catch(() => null) : null;
    const nomes = [lead.name, contato?.nome ?? ''].filter(Boolean);
    const conversa = (await conversaBruta)
      .map((m) => ({
        quem: m.direcao === 'entrada' ? ('paciente' as const) : ('clinica' as const),
        texto: anonimizar(m.texto || (m.anexo ? `[${m.anexo.tipo}]` : ''), nomes),
      }))
      .filter((f) => f.texto);
    const ctx = montarContextoDoCartao(lead, estrutura.funis, estrutura.defs);

    const inicio = performance.now();
    let uso = { promptTokens: 0, completionTokens: 0 };
    const chamar = chamarOpenAi(env.COPILOTO_OPENAI_API_KEY, env.COPILOTO_MODELO);
    try {
      const r = await responderAoCopiloto(
        async (p) => {
          const x = await chamar(p);
          uso = { promptTokens: x.promptTokens, completionTokens: x.completionTokens };
          return x;
        },
        { ctx, conversa, pergunta: pedido.pergunta, historico: pedido.historico.map((t) => ({ ...t, texto: anonimizar(t.texto, nomes) })) },
      );
      void recordLlmCall({ unitId: unit.id, traceId: null, provider: 'openai', model: env.COPILOTO_MODELO, promptTokens: uso.promptTokens, completionTokens: uso.completionTokens, latencyMs: Math.round(performance.now() - inicio), status: 'success' });
      // só números no log: nada de conversa nem de pergunta
      logger.info({ unit: unit.slug, leadId: pedido.leadId, etapa: ctx.etapaNome, sugestoes: r.saida.sugestoes.length, recusadas: r.saida.naoSugeri.length, tokens: uso.promptTokens + uso.completionTokens }, 'copiloto: pergunta respondida');
      res.json({ leadId: pedido.leadId, ...r.saida });
    } catch (err) {
      void recordLlmCall({ unitId: unit.id, traceId: null, provider: 'openai', model: env.COPILOTO_MODELO, latencyMs: Math.round(performance.now() - inicio), status: 'error', errorMessage: String(err).slice(0, 300) });
      throw err;
    }
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: pedido.leadId }, 'copiloto: falhou');
    res.status(502).json({ error: 'não consegui responder agora' });
  }
}
