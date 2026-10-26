/**
 * A vida de uma onda ANTES de sair: montar a lista, o João aprovar (ou cancelar). Quem manda é `lote.ts`.
 *
 * Estados: montando → montada → aprovada → concluida · e pausada / cancelada saindo de qualquer um deles.
 * O worker só enxerga `aprovada`. Nada passa de `montada` para `aprovada` sem `aprovarOnda`.
 */
import type { DisparoOnda, Prisma, Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { credenciaisDaUnidade } from '../whatsapp-meta.js';
import { lerPublico, reaproveitarDeOndaCancelada, type PublicoLido } from './publico.js';
import { conferirModeloNaMeta, definicaoParaAUnidade, impressaoDaOnda, podeAprovar, type Definicao } from './modelo.js';
import { problemaNoModelo, triar } from './regras.js';
import { freiosDoAmbiente } from './freios.js';
import { contarSairam } from './saidas.js';
import { recusaDaRetomada } from './retomada.js';

export type ResultadoDeAcao<T> = { ok: true; dados: T } | { ok: false; status: number; erro: string };

export const falha = (status: number, erro: string): { ok: false; status: number; erro: string } => ({ ok: false, status, erro });

export function definicaoDaOnda(o: Pick<DisparoOnda, 'template' | 'idioma' | 'textoModelo' | 'variaveis' | 'cabecalho'> & { oferta?: string | null }): Definicao {
  return {
    template: o.template,
    idioma: o.idioma,
    textoModelo: o.textoModelo,
    variaveis: (o.variaveis as unknown[]).map(String),
    cabecalho: (o.cabecalho as Definicao['cabecalho']) ?? null,
    ...(o.oferta?.trim() ? { oferta: o.oferta.trim() } : {}),
  };
}

/**
 * Valida o que dá para validar sem rede e abre a onda em `montando`. A lista é montada depois, em segundo plano
 * (`concluirMontagem`): para uma unidade com centenas de cartões são minutos de Kommo e de franquia.
 */
export async function abrirOnda(args: { campanha: string; unidade: string; etiqueta: string; por?: string | null }): Promise<ResultadoDeAcao<DisparoOnda>> {
  const etiqueta = args.etiqueta.trim();
  if (!etiqueta) return falha(400, 'diga a etiqueta do Kommo que forma a lista');
  const campanha = await prisma.disparoCampanha.findUnique({ where: { slug: args.campanha } });
  if (!campanha) return falha(404, 'campanha não encontrada');
  const unit = await prisma.unit.findUnique({ where: { slug: args.unidade } });
  if (!unit || !unit.isActive) return falha(404, 'unidade não encontrada');
  if (!credenciaisDaUnidade(unit)) return falha(422, 'a unidade não tem phone number id e token da Meta cadastrados');
  if (!unit.spineToken) return falha(422, 'a unidade não tem a franquia ligada: sem ela não dá para tirar quem tem consulta ou tratamento');
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) return falha(422, 'a unidade não tem Kommo configurado');

  const def = definicaoParaAUnidade(campanha, unit.slug);
  if ('erro' in def) return falha(422, def.erro);
  const problema = problemaNoModelo(def.textoModelo, def.variaveis);
  if (problema) return falha(422, problema);

  // Duas ondas vivas da mesma campanha na mesma unidade só atrapalham (a pessoa é única por campanha): quem chama
  // (a tela, a rotina ou o Claude) recebe o id da que já existe, em vez de montar outra por cima. A checagem e a criação
  // andam na mesma transação, sob uma trava do banco por campanha+unidade: duas chamadas ao mesmo tempo não furam a regra.
  const r = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`disparo-onda:${campanha.id}:${unit.id}`}))`;
    const viva = await tx.disparoOnda.findFirst({ where: { campanhaId: campanha.id, unitId: unit.id, estado: { in: ['montando', 'montada', 'aprovada', 'pausada'] } }, select: { id: true, estado: true } });
    if (viva) return { viva };
    const criada = await tx.disparoOnda.create({
      data: {
        campanhaId: campanha.id,
        unitId: unit.id,
        etiqueta,
        template: def.template,
        idioma: def.idioma,
        textoModelo: def.textoModelo,
        variaveis: def.variaveis as Prisma.InputJsonValue,
        cabecalho: (def.cabecalho ?? undefined) as Prisma.InputJsonValue | undefined,
        oferta: def.oferta ?? null,
        estado: 'montando',
        impressao: '',
        criadaPor: args.por ?? null,
      },
    });
    return { criada };
  });
  if ('viva' in r && r.viva) return falha(409, `já existe a onda ${r.viva.id} desta campanha nesta unidade (${r.viva.estado}); cancele-a antes de montar outra`);
  const onda = r.criada!;
  return { ok: true, dados: onda };
}

/**
 * Monta a lista de uma onda `montando`. Qualquer erro cancela a onda COM o motivo — nunca deixa meia lista aprovável.
 * `ler` é a porta para o Kommo, as conversas e a franquia (o teste troca por uma de mentira).
 */
export async function concluirMontagem(ondaId: string, ler: (unit: Unit, etiqueta: string, campanhaId: string) => Promise<PublicoLido> = lerPublico): Promise<void> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true } });
  if (!onda || onda.estado !== 'montando') return;
  const unit: Unit = onda.unit;
  try {
    const { candidatos, foraDoKommoDividido, jaNaCampanha, pediramSair, franquia } = await ler(unit, onda.etiqueta, onda.campanhaId);
    const { elegiveis, fora } = await triar(candidatos, { jaNaCampanha, pediramSair, franquia });

    // Linhas de ondas canceladas que nunca enviaram nada voltam para esta; o resto é criado.
    const reaproveitadas = await reaproveitarDeOndaCancelada(onda.campanhaId, unit.id, ondaId, elegiveis);
    const novas = await prisma.disparoDestinatario.createMany({
      data: elegiveis.map((e) => ({ ondaId, campanhaId: onda.campanhaId, unitId: unit.id, telefone: e.telefone, chave: e.chave, nome: e.nome, nomeCompleto: e.nomeCompleto || null, kommoLeadId: e.leadId })),
      skipDuplicates: true,
    });
    const criados = reaproveitadas + novas.count;
    const resumo = { candidatos: candidatos.length, fora, foraDoKommoDividido, montadaEm: new Date().toISOString() };

    if (criados === 0) {
      await prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'montando' }, data: { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível nesta etiqueta', resumo } });
      return;
    }
    const pessoas = await prisma.disparoDestinatario.findMany({ where: { ondaId }, select: { chave: true, nome: true } });
    // Só sai de `montando` se ninguém cancelou enquanto o Kommo e a franquia respondiam: onda cancelada NUNCA volta a ser aprovável.
    const fechou = await prisma.disparoOnda.updateMany({
      where: { id: ondaId, estado: 'montando' },
      data: { estado: 'montada', total: pessoas.length, resumo, impressao: impressaoDaOnda(definicaoDaOnda(onda), pessoas) },
    });
    if (fechou.count !== 1) {
      logger.warn({ onda: ondaId }, 'disparo: a onda foi cancelada durante a montagem — fica cancelada');
      return;
    }
    logger.info({ onda: ondaId, unit: unit.slug, total: pessoas.length, fora }, 'disparo: onda montada, esperando aprovação');
  } catch (err) {
    logger.error({ err: String(err), onda: ondaId }, 'disparo: montagem da onda falhou');
    await prisma.disparoOnda
      .updateMany({ where: { id: ondaId, estado: 'montando' }, data: { estado: 'cancelada', pausaMotivo: `montagem falhou: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } })
      .catch(() => undefined);
  }
}

/**
 * Uma aprovação por onda. Vale só se: quem aprova está na lista, o João viu EXATAMENTE esta lista e este texto
 * (`total` e `impressao` batem com o que o banco tem agora) e a Meta confirma o modelo.
 */
export async function aprovarOnda(
  ondaId: string,
  args: { por: string | null | undefined; total: unknown; impressao: unknown },
  conferir: typeof conferirModeloNaMeta = conferirModeloNaMeta,
): Promise<ResultadoDeAcao<DisparoOnda>> {
  if (!podeAprovar(args.por)) return falha(403, 'este usuário não está em DISPARO_APROVADORES');
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true } });
  if (!onda) return falha(404, 'onda não encontrada');
  if (onda.estado !== 'montada') return falha(409, `a onda está "${onda.estado}"; só se aprova uma onda montada`);

  const pessoas = await prisma.disparoDestinatario.findMany({ where: { ondaId, estado: 'pendente' }, select: { chave: true, nome: true } });
  const agora = impressaoDaOnda(definicaoDaOnda(onda), pessoas);
  if (pessoas.length !== onda.total || agora !== onda.impressao || args.total !== onda.total || args.impressao !== onda.impressao) {
    return falha(409, 'a lista ou o texto mudou desde que você abriu a tela; recarregue e confira de novo');
  }
  const meta = await conferir(onda.unit, definicaoDaOnda(onda));
  if (!meta.ok) return falha(422, meta.motivo);

  const r = await prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'montada' }, data: { estado: 'aprovada', aprovadaPor: args.por!.trim().toLowerCase(), aprovadaEm: new Date() } });
  if (r.count !== 1) return falha(409, 'a onda mudou de estado enquanto aprovava');
  logger.warn({ onda: ondaId, unit: onda.unit.slug, total: onda.total, por: args.por }, 'disparo: onda APROVADA');
  return { ok: true, dados: (await prisma.disparoOnda.findUnique({ where: { id: ondaId } }))! };
}

/** Parar é sempre seguro: a chave de serviço também pode. Os pendentes ficam como estão, para o registro. */
export async function cancelarOnda(ondaId: string, motivo: string): Promise<ResultadoDeAcao<DisparoOnda>> {
  const r = await prisma.disparoOnda.updateMany({
    where: { id: ondaId, estado: { in: ['montando', 'montada', 'aprovada', 'pausada'] } },
    data: { estado: 'cancelada', pausaMotivo: motivo.slice(0, 300) },
  });
  if (r.count !== 1) return falha(409, 'a onda não existe ou já está concluída/cancelada');
  return { ok: true, dados: (await prisma.disparoOnda.findUnique({ where: { id: ondaId } }))! };
}

/**
 * Retoma uma onda que PAROU POR SAIR. Decisão do João (26/10): só ele libera de novo, depois de ver quem pediu SAIR.
 *  - só e-mail de `DISPARO_APROVADORES` (a chave de serviço e o Claude nunca chegam aqui);
 *  - só a pausa por SAIR (token vencido ou aprovação velha pedem onda nova: o problema não é a lista);
 *  - o `sairam` que a tela mostrou tem de ser o de agora: se chegou mais um SAIR no meio, recusa e mostra de novo;
 *  - a Meta confirma o modelo de novo (pode ter mudado nos dias de pausa);
 *  - grava quantos SAIR ele viu (`sairAceitos`): o freio só volta a parar se vierem MAIS de `DISPARO_MAX_SAIR` depois disso.
 */
export async function retomarOnda(
  ondaId: string,
  args: { por: string | null | undefined; sairam: unknown },
  deps: { conferir?: typeof conferirModeloNaMeta; contar?: typeof contarSairam; agora?: () => Date } = {},
): Promise<ResultadoDeAcao<DisparoOnda>> {
  const conferir = deps.conferir ?? conferirModeloNaMeta;
  const contar = deps.contar ?? contarSairam;
  const agora = deps.agora ?? (() => new Date());
  if (!podeAprovar(args.por)) return falha(403, 'este usuário não está em DISPARO_APROVADORES');
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true } });
  if (!onda) return falha(404, 'onda não encontrada');
  const sairam = await contar(onda.campanhaId, onda.unitId);
  const recusa = recusaDaRetomada({ aprovador: true, estado: onda.estado, pausaCausa: onda.pausaCausa, aprovadaEm: onda.aprovadaEm, validadeDias: freiosDoAmbiente().validadeDias, agora: agora(), sairamAgora: sairam, sairamVisto: args.sairam });
  if (recusa) return falha(recusa.status, recusa.erro);
  const meta = await conferir(onda.unit, definicaoDaOnda(onda));
  if (!meta.ok) return falha(422, meta.motivo);

  const r = await prisma.disparoOnda.updateMany({
    where: { id: ondaId, estado: 'pausada', pausaCausa: 'sair' },
    data: { estado: 'aprovada', sairAceitos: sairam, retomadaPor: args.por!.trim().toLowerCase(), retomadaEm: agora(), pausaMotivo: null, pausaCausa: null },
  });
  if (r.count !== 1) return falha(409, 'a onda mudou de estado enquanto retomava');
  logger.warn({ onda: ondaId, unit: onda.unit.slug, sairAceitos: sairam, por: args.por }, 'disparo: onda RETOMADA depois de pausa por SAIR');
  return { ok: true, dados: (await prisma.disparoOnda.findUnique({ where: { id: ondaId } }))! };
}
