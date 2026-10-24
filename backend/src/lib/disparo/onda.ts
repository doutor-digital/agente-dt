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

export type ResultadoDeAcao<T> = { ok: true; dados: T } | { ok: false; status: number; erro: string };

export const falha = (status: number, erro: string): { ok: false; status: number; erro: string } => ({ ok: false, status, erro });

export function definicaoDaOnda(o: Pick<DisparoOnda, 'template' | 'idioma' | 'textoModelo' | 'variaveis' | 'cabecalho'>): Definicao {
  return {
    template: o.template,
    idioma: o.idioma,
    textoModelo: o.textoModelo,
    variaveis: (o.variaveis as unknown[]).map(String),
    cabecalho: (o.cabecalho as Definicao['cabecalho']) ?? null,
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

  const onda = await prisma.disparoOnda.create({
    data: {
      campanhaId: campanha.id,
      unitId: unit.id,
      etiqueta,
      template: def.template,
      idioma: def.idioma,
      textoModelo: def.textoModelo,
      variaveis: def.variaveis as Prisma.InputJsonValue,
      cabecalho: (def.cabecalho ?? undefined) as Prisma.InputJsonValue | undefined,
      estado: 'montando',
      impressao: '',
      criadaPor: args.por ?? null,
    },
  });
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
      await prisma.disparoOnda.update({ where: { id: ondaId }, data: { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível nesta etiqueta', resumo } });
      return;
    }
    const pessoas = await prisma.disparoDestinatario.findMany({ where: { ondaId }, select: { chave: true, nome: true } });
    await prisma.disparoOnda.update({
      where: { id: ondaId },
      data: { estado: 'montada', total: pessoas.length, resumo, impressao: impressaoDaOnda(definicaoDaOnda(onda), pessoas) },
    });
    logger.info({ onda: ondaId, unit: unit.slug, total: pessoas.length, fora }, 'disparo: onda montada, esperando aprovação');
  } catch (err) {
    logger.error({ err: String(err), onda: ondaId }, 'disparo: montagem da onda falhou');
    await prisma.disparoOnda
      .update({ where: { id: ondaId }, data: { estado: 'cancelada', pausaMotivo: `montagem falhou: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } })
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
