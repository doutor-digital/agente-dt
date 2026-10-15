/**
 * Ponte, fase 3 (14/10/2026) — as ações do painel no Kommo: ETIQUETAS, o resultado da LIGAÇÃO e as RESPOSTAS
 * PRONTAS. Mesma chave por unidade dos widgets (`X-Widget-Key`), cada rota com o seu balde de limite.
 *
 *   - `GET    /api/public/widget/:slug/ponte/etiquetas` → as etiquetas que JÁ EXISTEM na conta (cache 10 min);
 *   - `POST   /api/public/widget/:slug/ponte/etiquetas` `{ leadId, nome, por, confirmado? }` → põe (▶ exige `confirmado`);
 *   - `DELETE /api/public/widget/:slug/ponte/etiquetas` `{ leadId, nome, por }` → tira;
 *   - `POST   /api/public/widget/:slug/ponte/ligacao` `{ leadId, resultado, por }` → campos ☎ + nota;
 *   - `GET    /api/public/widget/:slug/ponte/respostas` → os modelos gerais (texto livre) da conta, para COPIAR;
 *   - `POST   /api/public/widget/:slug/ponte/nota` `{ leadId, texto, por }` → 0.5.1: a OBSERVAÇÃO da atendente vira uma
 *     nota comum no cartão ("Observação pela Ponte · Ana · 15/10/2026 15:42:"; ver `lib/ponte-nota.ts`).
 *
 * Tudo vai no Kommo pela chave da unidade — nunca no WhatsApp. A Ponte não envia, não liga e não digita nada lá.
 * Log sem dado de paciente: id do cartão, nome da etiqueta e o resultado, nada de nome nem telefone.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';
import { createKommoClient } from '../services/kommo.service.js';
import { contaDaUnidade } from '../lib/ponte-cache.js';
import {
  ehEtiquetaDeRobo,
  etiquetasDaConta,
  etiquetasDeRoboDaUnidade,
  lerPedidoDeEtiqueta,
  porEtiqueta,
  tirarEtiqueta,
  type ResultadoDaEtiqueta,
} from '../lib/ponte-etiquetas.js';
import { camposDaConta, lerPedidoDeLigacao, registrarLigacaoUmaVez } from '../lib/ponte-ligacao.js';
import { ONDE_CADASTRAR_RESPOSTAS, respostasDaConta } from '../lib/ponte-respostas.js';
import { gravarObservacaoUmaVez, lerPedidoDeNota } from '../lib/ponte-nota.js';

/** Leitura (listas da conta): o painel pede ao abrir o "+ etiqueta" e a aba Respostas. */
const LIMITE_DE_LEITURA = { balde: 'ponte-listas', max: 60 };
/** Escrita de etiqueta: uma atendente mexe em poucas por minuto. */
const LIMITE_DA_ETIQUETA = { balde: 'ponte-etiqueta', max: 30 };
/** Resultado de ligação: o ritmo da fila já segura (1 a cada 40 s); o limite é só a trava de cima. */
const LIMITE_DA_LIGACAO = { balde: 'ponte-ligacao', max: 30 };
/** Observação: escrita, uma atendente escreve poucas por minuto. */
const LIMITE_DA_NOTA = { balde: 'ponte-nota', max: 30 };

async function unidadeComKommo(req: Request, res: Response, limite: { balde: string; max: number }): Promise<Unit | null> {
  const unit = await unidadeDaPonte(req, res, limite);
  if (!unit) return null;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return null;
  }
  return unit;
}

// ── etiquetas ──

/** `GET …/ponte/etiquetas` */
export async function ponteEtiquetasDaContaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DE_LEITURA);
  if (!unit) return;
  try {
    const nomes = await etiquetasDaConta(contaDaUnidade(unit), createKommoClient(unit));
    // `robo` é a regra do servidor (▶ + a lista da unidade): o painel pede confirmação por ela
    const robos = etiquetasDeRoboDaUnidade(unit.slug);
    res.json({ etiquetas: nomes.map((nome) => ({ nome, robo: ehEtiquetaDeRobo(nome, robos) })), agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte: não li as etiquetas da conta');
    res.status(502).json({ error: 'não consegui ler as etiquetas do Kommo agora' });
  }
}

function responderEtiqueta(res: Response, r: ResultadoDaEtiqueta): void {
  if (!r.ok) {
    res.status(r.status).json({ error: r.erro, ...(r.precisaConfirmar ? { precisaConfirmar: true } : {}) });
    return;
  }
  res.json({ leadId: r.leadId, nome: r.nome, robo: r.robo, mudou: r.mudou, etiquetas: r.etiquetas, ...(r.nota !== undefined ? { nota: r.nota } : {}), agora: new Date() });
}

async function mexerNaEtiqueta(req: Request, res: Response, acao: 'por' | 'tirar'): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DA_ETIQUETA);
  if (!unit) return;
  const lido = lerPedidoDeEtiqueta(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const { leadId, nome } = lido.pedido;
  const robos = etiquetasDeRoboDaUnidade(unit.slug);
  try {
    const kommo = createKommoClient(unit);
    const r = acao === 'por' ? await porEtiqueta(contaDaUnidade(unit), kommo, lido.pedido, { robos }) : await tirarEtiqueta(kommo, lido.pedido, { robos });
    // o nome da etiqueta não é dado de paciente ("LOMBAR", "▶ Retomada"); quem pôs fica na nota, não no log
    logger.info(
      { unit: unit.slug, leadId, etiqueta: r.ok ? r.nome : nome, acao, ok: r.ok, mudou: r.ok ? r.mudou : false, robo: ehEtiquetaDeRobo(r.ok ? r.nome : nome, robos) },
      'ponte: etiqueta',
    );
    responderEtiqueta(res, r);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId, acao }, 'ponte: falha ao mexer na etiqueta');
    res.status(502).json({ error: acao === 'por' ? 'não consegui pôr a etiqueta agora' : 'não consegui tirar a etiqueta agora' });
  }
}

/** `POST …/ponte/etiquetas` `{ leadId, nome, por?, confirmado? }` */
export function pontePorEtiquetaHandler(req: Request, res: Response): Promise<void> {
  return mexerNaEtiqueta(req, res, 'por');
}

/** `DELETE …/ponte/etiquetas` `{ leadId, nome, por? }` */
export function ponteTirarEtiquetaHandler(req: Request, res: Response): Promise<void> {
  return mexerNaEtiqueta(req, res, 'tirar');
}

// ── ligação ──

/** `POST …/ponte/ligacao` `{ leadId, resultado, por? }` */
export async function ponteLigacaoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DA_LIGACAO);
  if (!unit) return;
  const lido = lerPedidoDeLigacao(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const { leadId, resultado } = lido.pedido;
  try {
    const r = await registrarLigacaoUmaVez(contaDaUnidade(unit), createKommoClient(unit), lido.pedido);
    if (!r.ok) {
      logger.warn({ unit: unit.slug, leadId, resultado, status: r.status }, 'ponte: ligação não registrada');
      res.status(r.status).json({ error: r.erro });
      return;
    }
    logger.info({ unit: unit.slug, leadId, resultado: r.resultado, campos: r.campos, nota: r.nota, repetido: !!r.repetido, origem: 'ponte' }, 'ponte: ligação registrada');
    // repetido: a mesma tentativa já tinha gravado — volta o que foi gravado da primeira vez
    res.json({ leadId, resultado: r.resultado, campos: r.campos, nota: r.nota, tentativas: r.tentativas, avisos: r.avisos, repetido: !!r.repetido, agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId, resultado }, 'ponte: falha ao registrar a ligação');
    res.status(502).json({ error: 'não consegui gravar a ligação no Kommo agora' });
  }
}

// ── 0.5.1: observação (nota comum no cartão) ──

/** `POST …/ponte/nota` `{ leadId, texto, por? }` → `{ ok: true, leadId, notaId, repetido }` ou `{ ok: false, error }`. */
export async function ponteNotaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DA_NOTA);
  if (!unit) return;
  const lido = lerPedidoDeNota(req.body);
  if (!lido.ok) {
    res.status(400).json({ ok: false, error: lido.erro });
    return;
  }
  const { leadId, texto } = lido.pedido;
  try {
    const r = await gravarObservacaoUmaVez(contaDaUnidade(unit), createKommoClient(unit), lido.pedido);
    if (!r.ok) {
      logger.warn({ unit: unit.slug, leadId, status: r.status, incerto: !!r.incerto }, 'ponte: observação não gravada');
      res.status(r.status).json({ ok: false, error: r.erro });
      return;
    }
    // o texto é do paciente: no log, só o tamanho
    logger.info({ unit: unit.slug, leadId, notaId: r.notaId, letras: texto.length, repetido: !!r.repetido, origem: 'ponte' }, 'ponte: observação gravada');
    res.json({ ok: true, leadId, notaId: r.notaId, repetido: !!r.repetido, agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: falha ao gravar a observação');
    res.status(502).json({ ok: false, error: 'não consegui gravar a observação no Kommo agora' });
  }
}

// ── respostas prontas ──

/** `GET …/ponte/respostas` */
export async function ponteRespostasHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DE_LEITURA);
  if (!unit) return;
  const conta = contaDaUnidade(unit);
  try {
    const kommo = createKommoClient(unit);
    const respostas = await respostasDaConta(conta, async () => {
      const [modelos, campos] = await Promise.all([kommo.listChatTemplates(), camposDaConta(conta, kommo).catch(() => [])]);
      const nomes = new Map(campos.map((c) => [c.id, c.name]));
      return { modelos, nomeDoCampo: (id: number) => nomes.get(id) ?? null };
    });
    res.json({ respostas, ondeCadastrar: ONDE_CADASTRAR_RESPOSTAS, agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte: não li as respostas prontas');
    res.status(502).json({ error: 'não consegui ler as respostas prontas do Kommo agora' });
  }
}
