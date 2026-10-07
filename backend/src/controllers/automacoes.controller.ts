/**
 * A tela "Automações": o que existe, o que está ligado em cada unidade, e o botão que muda isso.
 *
 * O ponto da tela não é ligar/desligar — é PARAR DE ESQUECER. Antes disto a resposta para "o worker
 * de parados está ligado na Serra?" exigia abrir o Docker da VPS e ler um csv. Por isso o GET devolve
 * o catálogo inteiro (as 24, ligadas e desligadas) com o que cada uma faz e a pegadinha de cada uma,
 * e não só as que estão ativas: automação invisível é automação que ninguém opera.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { automacaoPorId } from '../lib/automacoes.js';
import { ACOES_SIMULADAS, resumirSimulacoes } from '../lib/so-no-papel.js';
import {
  ehEstado,
  invalidarAutomacoes,
  panoramaDaUnidade,
  recarregarAutomacoes,
  type Estado,
} from '../lib/automacoes-estado.js';

/** GET /units/:id/automacoes — o catálogo com o estado desta unidade. */
export async function listarAutomacoesHandler(req: Request, res: Response): Promise<void> {
  const unit = await prisma.unit.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, slug: true, name: true },
  });
  if (!unit) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }
  // Releitura forçada: quem abriu a tela quer ver o estado agora, não o de até 30 s atrás — e é a
  // única chamada rara o bastante para pagar uma ida ao banco.
  await recarregarAutomacoes();
  res.json({
    unidade: { id: unit.id, slug: unit.slug, nome: unit.name },
    automacoes: panoramaDaUnidade(unit.slug),
  });
}

/** PUT /units/:id/automacoes/:automacao — liga, põe em seco ou desliga. */
export async function definirAutomacaoHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const idAutomacao = String(req.params.automacao);
  const estado = (req.body as { estado?: unknown } | undefined)?.estado;

  const catalogo = automacaoPorId(idAutomacao);
  if (!catalogo) {
    res.status(404).json({ erro: `automação desconhecida: ${idAutomacao}` });
    return;
  }
  if (!ehEstado(estado)) {
    res.status(400).json({ erro: 'estado precisa ser "ligado", "seco" ou "desligado"' });
    return;
  }
  if (estado === 'seco' && !catalogo.temSeco) {
    res.status(400).json({ erro: `"${catalogo.nome}" não tem modo seco` });
    return;
  }

  const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true, slug: true } });
  if (!unit) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }

  const quem = (req as { user?: { email?: string } }).user?.email ?? null;
  await prisma.unitAutomacao.upsert({
    where: { unitId_automacao: { unitId: unit.id, automacao: idAutomacao } },
    create: { unitId: unit.id, automacao: idAutomacao, estado, atualizadoPor: quem },
    update: { estado, atualizadoPor: quem },
  });

  // Vale já na próxima pergunta, sem esperar os 30 s do cache — é o que faz a tela parecer instantânea.
  invalidarAutomacoes();
  await recarregarAutomacoes();

  logger.warn(
    { unit: unit.slug, automacao: idAutomacao, estado, risco: catalogo.risco, por: quem },
    'automação alterada pela tela',
  );
  res.json({ ok: true, automacoes: panoramaDaUnidade(unit.slug) });
}

/**
 * DELETE /units/:id/automacoes/:automacao — devolve a decisão pro `.env`.
 *
 * Existe porque "desligado" e "não opinei" são coisas diferentes: apagar a linha faz a unidade voltar
 * a seguir a variável de ambiente, que é como ela estava antes de alguém mexer.
 */
export async function limparAutomacaoHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id);
  const idAutomacao = String(req.params.automacao);
  const unit = await prisma.unit.findUnique({ where: { id: unitId }, select: { id: true, slug: true } });
  if (!unit) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }
  await prisma.unitAutomacao
    .delete({ where: { unitId_automacao: { unitId: unit.id, automacao: idAutomacao } } })
    .catch(() => null); // já não havia linha: o resultado desejado já é o atual
  invalidarAutomacoes();
  await recarregarAutomacoes();
  logger.warn({ unit: unit.slug, automacao: idAutomacao }, 'automação devolvida ao .env');
  res.json({ ok: true, automacoes: panoramaDaUnidade(unit.slug) });
}

/**
 * GET /automacoes/rede — a mesma pergunta para todas as unidades de uma vez.
 *
 * É a tela que responde "onde isto está ligado?", que é como o João pensa quando lembra de uma
 * automação e não de quem a tem.
 */
export async function redeAutomacoesHandler(_req: Request, res: Response): Promise<void> {
  const units = await prisma.unit.findMany({
    where: { isActive: true },
    select: { id: true, slug: true, name: true },
    orderBy: { name: 'asc' },
  });
  await recarregarAutomacoes();
  const unidades = units.map((u) => ({
    id: u.id,
    slug: u.slug,
    nome: u.name,
    estados: Object.fromEntries(panoramaDaUnidade(u.slug).map((a) => [a.id, a.estado])) as Record<string, Estado>,
  }));
  res.json({ unidades, automacoes: panoramaDaUnidade(units[0]?.slug ?? '') });
}

/**
 * GET /units/:id/automacoes/:automacao/simulacoes?dias=7&acao=diverge — o que a automação fez "só no papel": uma linha
 * por cartão e decisão (moveria/gravaria; nos robôs de campo, confere/diverge do que a SDR pôs). É o que
 * a tela mostra para conferir antes de ligar. Ver `lib/so-no-papel.ts`.
 */
export async function simulacoesHandler(req: Request, res: Response): Promise<void> {
  const idAutomacao = String(req.params.automacao);
  if (!automacaoPorId(idAutomacao)) {
    res.status(404).json({ erro: `automação desconhecida: ${idAutomacao}` });
    return;
  }
  const unit = await prisma.unit.findUnique({ where: { id: String(req.params.id) }, select: { id: true, kommoSubdomain: true } });
  if (!unit) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }
  const dias = Math.min(30, Math.max(1, Number(req.query.dias) || 7));
  const desde = new Date(Date.now() - dias * 86_400_000);
  const where = { unitId: unit.id, automacao: idAutomacao, ultimaEm: { gte: desde } };
  // o filtro vale para a lista E para o "mostrando X de Y" — o placar continua mostrando todas as ações
  const acao = typeof req.query.acao === 'string' && (ACOES_SIMULADAS as readonly string[]).includes(req.query.acao) ? req.query.acao : null;
  const daLista = acao ? { ...where, acao } : where;
  const [todos, itens] = await Promise.all([
    prisma.automacaoSimulacao.findMany({ where, select: { acao: true, kommoLeadId: true } }),
    prisma.automacaoSimulacao.findMany({ where: daLista, orderBy: { ultimaEm: 'desc' }, take: 300 }),
  ]);
  res.json({
    automacao: idAutomacao,
    dias,
    kommoSubdomain: unit.kommoSubdomain,
    resumo: resumirSimulacoes(todos),
    total: acao ? todos.filter((t) => t.acao === acao).length : todos.length,
    itens: itens.map((i) => ({
      leadId: i.kommoLeadId,
      acao: i.acao,
      alvo: i.alvo,
      valor: i.valor,
      noCartao: i.noCartao,
      deEtapa: i.deEtapa,
      motivo: i.motivo,
      primeiraEm: i.primeiraEm,
      ultimaEm: i.ultimaEm,
    })),
  });
}

