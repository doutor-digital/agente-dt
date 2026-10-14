/**
 * Ponte, fase 4 (0.4.0, 14/10/2026) — "O que eu faço agora?": o guia da SDR pela etapa do cartão. As regras estão em
 * `lib/ponte-guia.ts`; aqui só se lê a conta (com cache) e se responde. Mesma chave por unidade dos widgets
 * (`X-Widget-Key`, conferida ANTES do limitador em `unidadeDaPonte`), cada rota com o seu balde.
 *
 *   - `GET  /api/public/widget/:slug/ponte/guia?leadId=` → etapa, ⚠ pendência, unidade (Petrópolis × Caxias), o que
 *     falta nesta etapa e as saídas (com o que falta em cada uma e as mensagens conhecidas dos robôs). SÓ LEITURA;
 *   - `POST /api/public/widget/:slug/ponte/campos` `{ leadId, campos: [{ id, valor }], por }` → grava só o que mudou
 *     (um PATCH), relê o cartão e devolve o guia novo. Nota "✎ Preenchido pela Ponte · por Ana";
 *   - `POST /api/public/widget/:slug/ponte/mover` `{ leadId, de, para, campos?, por, confirmado }` → muda a etapa (e
 *     grava junto o que faltava), relê e devolve o guia novo. Nota "➜ Etapa mudada pela Ponte · por Ana".
 *
 * A Ponte NÃO escreve na franquia. No Kommo, só no clique da atendente — nunca no WhatsApp. Log sem dado de
 * paciente: id do cartão, ids e nomes dos campos e das etapas; nunca o valor digitado.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';
import { dadosDaConta } from './ponte.controller.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { CacheDaConta, contaDaUnidade } from '../lib/ponte-cache.js';
import { camposDaConta } from '../lib/ponte-ligacao.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { leadIdDoPedido } from '../lib/ponte-pausa.js';
import {
  gravarCamposPelaPonte,
  guiaDoCartao,
  lerPedidoDeCampos,
  lerPedidoDeMover,
  mensagensDaUnidade,
  moverPelaPonte,
  type ContaDoGuia,
  type GuiaDoCartao,
  type Recusa,
} from '../lib/ponte-guia.js';

/** Leitura: a atendente abre o guia de um paciente por vez. */
const LIMITE_DO_GUIA = { balde: 'ponte-guia', max: 60 };
/** Escrita de campos: poucos por minuto. */
const LIMITE_DOS_CAMPOS = { balde: 'ponte-campos', max: 30 };
/** Mudar etapa dispara robô: balde próprio e baixo (há também o teto por hora da conta, em `ponte-guia.ts`). */
const LIMITE_DO_MOVER = { balde: 'ponte-mover', max: 20 };

/** Os motivos de perda mudam pouco: 10 min por conta. */
const cacheMotivos = new CacheDaConta<Array<{ id: number; name: string }>>(10 * 60_000);

async function unidadeComKommo(req: Request, res: Response, limite: { balde: string; max: number }): Promise<Unit | null> {
  const unit = await unidadeDaPonte(req, res, limite);
  if (!unit) return null;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return null;
  }
  return unit;
}

/** O que o guia precisa da conta: campos (10 min), funis (10 min), fuso, mensagens conhecidas e motivos de perda. */
async function contaDoGuia(unit: Unit, kommo: KommoClient): Promise<ContaDoGuia> {
  const conta = contaDaUnidade(unit);
  const [defs, dados] = await Promise.all([camposDaConta(conta, kommo), dadosDaConta(unit, kommo)]);
  if (!dados.funis.length) throw new Error('funis do Kommo indisponíveis');
  return {
    conta,
    defs,
    funis: dados.funis,
    tz: fusoDaUnidade(unit),
    mensagens: mensagensDaUnidade(unit),
    motivosDePerda: () => cacheMotivos.obter(conta, () => kommo.listLossReasons()),
  };
}

const linkDo = (unit: Unit, leadId: number) => `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${leadId}`;

function comLink(unit: Unit, guia: GuiaDoCartao) {
  return { ...guia, link: linkDo(unit, guia.leadId) };
}

function recusar(res: Response, r: Recusa): void {
  res.status(r.status).json({
    error: r.erro,
    ...(r.precisaUnidade ? { precisaUnidade: true } : {}),
    ...(r.precisaConfirmar ? { precisaConfirmar: true } : {}),
    ...(r.faltam ? { faltam: r.faltam } : {}),
  });
}

/** `GET …/ponte/guia?leadId=` */
export async function ponteGuiaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DO_GUIA);
  if (!unit) return;
  const leadId = leadIdDoPedido(req.query.leadId);
  if (!leadId) {
    res.status(400).json({ error: 'lead inválido' });
    return;
  }
  try {
    const kommo = createKommoClient(unit);
    const r = await guiaDoCartao(await contaDoGuia(unit, kommo), kommo, leadId);
    if (!r.ok) return recusar(res, r);
    logger.info(
      { unit: unit.slug, leadId, etapa: r.guia.etapa, faltam: r.guia.faltam.length, saidas: r.guia.saidas.length, unidade: r.guia.unidade?.precisa ?? null },
      'ponte: guia do cartão',
    );
    res.json({ ...comLink(unit, r.guia), agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: falha ao montar o guia');
    res.status(502).json({ error: 'não consegui ler o cartão no Kommo agora' });
  }
}

/** `POST …/ponte/campos` `{ leadId, campos: [{ id, valor }], por? }` */
export async function ponteCamposHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DOS_CAMPOS);
  if (!unit) return;
  const lido = lerPedidoDeCampos(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const { leadId } = lido.pedido;
  try {
    const kommo = createKommoClient(unit);
    const r = await gravarCamposPelaPonte(await contaDoGuia(unit, kommo), kommo, lido.pedido);
    if (!r.ok) {
      logger.info({ unit: unit.slug, leadId, status: r.status, campos: lido.pedido.campos.map((c) => c.id) }, 'ponte: campos recusados');
      return recusar(res, r);
    }
    // os NOMES dos campos vão para o log; os valores, nunca (podem ser dado de saúde do paciente)
    logger.info({ unit: unit.slug, leadId, gravados: r.gravados.map((g) => g.nome), iguais: r.iguais.length, nota: r.nota, origem: 'ponte' }, 'ponte: campos gravados');
    res.json({ leadId, gravados: r.gravados, iguais: r.iguais, nota: r.nota, guia: comLink(unit, r.guia), agora: new Date() });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'ponte: falha ao gravar campos');
    res.status(502).json({ error: 'não consegui gravar no Kommo agora' });
  }
}

/** `POST …/ponte/mover` `{ leadId, de, para, campos?, por?, confirmado }` */
export async function ponteMoverHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComKommo(req, res, LIMITE_DO_MOVER);
  if (!unit) return;
  const lido = lerPedidoDeMover(req.body);
  if (!lido.ok) {
    res.status(400).json({ error: lido.erro });
    return;
  }
  const { leadId, de, para } = lido.pedido;
  try {
    const kommo = createKommoClient(unit);
    const r = await moverPelaPonte(await contaDoGuia(unit, kommo), kommo, lido.pedido);
    if (!r.ok) {
      logger.info({ unit: unit.slug, leadId, de, para, status: r.status }, 'ponte: mover recusado');
      return recusar(res, r);
    }
    logger.info(
      { unit: unit.slug, leadId, de: r.de, para: r.para, gravados: r.gravados.map((g) => g.nome), motivoDePerda: r.motivoDePerda, nota: r.nota, origem: 'ponte' },
      'ponte: cartão movido',
    );
    res.json({
      leadId,
      de: r.de,
      para: r.para,
      gravados: r.gravados,
      motivoDePerda: r.motivoDePerda,
      nota: r.nota,
      guia: comLink(unit, r.guia),
      agora: new Date(),
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId, de, para }, 'ponte: falha ao mover o cartão');
    res.status(502).json({ error: 'não consegui mudar a etapa no Kommo agora' });
  }
}
