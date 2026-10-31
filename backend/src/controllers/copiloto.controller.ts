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
import { createKommoClient, type CampoDoCartaoDaConta, type KommoClient, type KommoPipeline } from '../services/kommo.service.js';
import { contaDoKommo, unidadeParaOCartao } from '../lib/crm-compartilhado.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';
import { recordLlmCall } from '../services/openai.service.js';
import { montarContextoDoCartao } from '../lib/copiloto/contexto.js';
import { chamarOpenAi } from '../lib/copiloto/openai.js';
import { lerPedido } from '../lib/copiloto/pedido.js';
import { responderAoCopiloto } from '../lib/copiloto/responder.js';
import { corpoDaSessao, criarSessaoDeVoz, instrucoesDaVoz, lerEtapaDoPedido, LIMITE_DA_CONVERSA_S, reservarSessao } from '../lib/copiloto/voz.js';

// 10 perguntas por minuto por unidade: cada pergunta faz de 6 a 8 chamadas ao Kommo, que tem fila única no processo
const LIMITE = { balde: 'copiloto', max: 10 };
const CACHE_DO_KOMMO_MS = 10 * 60_000;
const cacheEstrutura = new Map<string, { em: number; funis: KommoPipeline[]; defs: CampoDoCartaoDaConta[] }>();

async function estruturaDaConta(unit: Pick<Unit, 'id'>, kommo: KommoClient) {
  const g = cacheEstrutura.get(unit.id);
  if (g && Date.now() - g.em < CACHE_DO_KOMMO_MS) return g;
  // `listarCamposDoCartao` pagina (contas passam de 250 campos) e traz todos os tipos
  const [funis, defs] = await Promise.all([kommo.listPipelines(), kommo.listarCamposDoCartao()]);
  const novo = { em: Date.now(), funis, defs };
  cacheEstrutura.set(unit.id, novo);
  return novo;
}

export async function copilotoPerguntarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE);
  if (!unit) return;
  // vazio = desligado em toda a rede (sem nenhuma chamada ao Kommo)
  if (!env.COPILOTO_UNIDADES.length) {
    res.status(404).json({ error: 'copiloto não liberado para esta unidade' });
    return;
  }
  if (!env.COPILOTO_OPENAI_API_KEY) {
    res.status(503).json({ error: 'copiloto sem chave da IA' });
    return;
  }
  const pedido = lerPedido(req.body);
  if ('erro' in pedido) {
    res.status(400).json({ error: pedido.erro });
    return;
  }

  try {
    // Kommo dividido (Petrópolis × Caxias): o widget chega SEMPRE pela unidade dona da conta, para os cartões das duas.
    // A unidade EFETIVA é a do cartão (campo ⌂ Unidade de atendimento); é ela que precisa estar liberada. Para quem só LÊ,
    // cartão sem unidade e unidade sem franquia não impedem: valem a unidade do pedido e o Kommo da conta.
    const dono = await unidadeParaOCartao(unit, pedido.leadId);
    const efetiva: Pick<Unit, 'id' | 'slug'> = dono.tipo === 'unidade' ? dono.unit : unit;
    if (!env.COPILOTO_UNIDADES.includes(efetiva.slug)) {
      res.status(404).json({ error: 'copiloto não liberado para esta unidade' });
      return;
    }
    const conta = await contaDoKommo(unit);
    if (!conta.kommoSubdomain || !conta.kommoAccessToken) {
      res.status(409).json({ error: 'unidade sem Kommo conectado' });
      return;
    }
    const kommo = createKommoClient(conta);
    const conversaBruta = mensagensOficiais(kommo, pedido.leadId, 40).catch(() => []);
    const [lead, estrutura] = await Promise.all([kommo.getLead(pedido.leadId), estruturaDaConta(conta, kommo)]);
    const contatoId = lead._embedded?.contacts?.find((c) => c.is_main)?.id ?? lead._embedded?.contacts?.[0]?.id;
    const contato = contatoId ? await kommo.getContactBasico(contatoId).catch(() => null) : null;
    const nomes = [lead.name, contato?.nome ?? ''].filter(Boolean);
    const conversa = (await conversaBruta)
      .map((m) => ({
        quem: m.direcao === 'entrada' ? ('paciente' as const) : ('clinica' as const),
        texto: m.texto || (m.anexo ? `[${m.anexo.tipo}]` : ''),
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
        // nome, telefone, e-mail e CPF saem de TUDO (conversa, pergunta, histórico e valores dos campos) dentro de `responderAoCopiloto`
        { ctx, conversa, pergunta: pedido.pergunta, historico: pedido.historico, papel: pedido.papel, nomes },
      );
      void recordLlmCall({ unitId: efetiva.id, traceId: null, provider: 'openai', model: env.COPILOTO_MODELO, promptTokens: uso.promptTokens, completionTokens: uso.completionTokens, latencyMs: Math.round(performance.now() - inicio), status: 'success' });
      // só números no log: nada de conversa nem de pergunta
      logger.info({ unit: efetiva.slug, leadId: pedido.leadId, etapa: ctx.etapaNome, sugestoes: r.saida.sugestoes.length, recusadas: r.saida.naoSugeri.length, tokens: uso.promptTokens + uso.completionTokens }, 'copiloto: pergunta respondida');
      res.json({ leadId: pedido.leadId, ...r.saida });
    } catch (err) {
      void recordLlmCall({ unitId: efetiva.id, traceId: null, provider: 'openai', model: env.COPILOTO_MODELO, latencyMs: Math.round(performance.now() - inicio), status: 'error', errorMessage: String(err).slice(0, 300) });
      throw err;
    }
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: pedido.leadId }, 'copiloto: falhou');
    res.status(502).json({ error: 'não consegui responder agora' });
  }
}

// 6 pedidos por minuto por unidade: cada um abre uma conversa que custa por minuto falado
const LIMITE_VOZ = { balde: 'copiloto-voz', max: 6 };

/**
 * `POST /api/public/widget/:slug/copiloto/voz/sessao`  `{ etapa? }`
 *
 * Emite o acesso temporário para a conversa por voz (OpenAI Realtime). O áudio NÃO passa por aqui. Não recebe cartão nem
 * conversa de paciente: só o nome da etapa. Libera pela unidade do pedido (COPILOTO_UNIDADES); em Kommo dividido
 * (Petrópolis × Caxias) o widget chega pela unidade dona da conta, que precisa estar na lista.
 */
export async function copilotoVozSessaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_VOZ);
  if (!unit) return;
  if (!env.COPILOTO_UNIDADES.includes(unit.slug)) {
    res.status(404).json({ error: 'copiloto não liberado para esta unidade' });
    return;
  }
  if (!env.COPILOTO_OPENAI_API_KEY) {
    res.status(503).json({ error: 'copiloto sem chave da IA' });
    return;
  }
  if (!reservarSessao(unit.slug, env.COPILOTO_VOZ_SESSOES_DIA)) {
    res.status(429).json({ error: 'limite de conversas por voz de hoje atingido' });
    return;
  }
  const inicio = performance.now();
  try {
    const etapa = lerEtapaDoPedido(req.body);
    const corpo = corpoDaSessao(env.COPILOTO_VOZ_MODELO, env.COPILOTO_VOZ_VOZ, instrucoesDaVoz(etapa));
    const sessao = await criarSessaoDeVoz(env.COPILOTO_OPENAI_API_KEY, corpo);
    void recordLlmCall({ unitId: unit.id, traceId: null, provider: 'openai', model: env.COPILOTO_VOZ_MODELO, latencyMs: Math.round(performance.now() - inicio), status: 'success' });
    // só números no log
    logger.info({ unit: unit.slug, etapa: etapa ?? null }, 'copiloto: conversa por voz aberta');
    res.json({ segredo: sessao.segredo, expiraEm: sessao.expiraEm, modelo: env.COPILOTO_VOZ_MODELO, limiteSegundos: LIMITE_DA_CONVERSA_S });
  } catch (err) {
    void recordLlmCall({ unitId: unit.id, traceId: null, provider: 'openai', model: env.COPILOTO_VOZ_MODELO, latencyMs: Math.round(performance.now() - inicio), status: 'error', errorMessage: String(err).slice(0, 300) });
    logger.warn({ err: String(err), unit: unit.slug }, 'copiloto: voz falhou');
    res.status(502).json({ error: 'não consegui abrir a conversa por voz agora' });
  }
}
