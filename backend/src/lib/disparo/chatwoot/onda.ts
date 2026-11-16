/**
 * A vida de uma onda da origem «chatwoot» ANTES de sair: abrir, montar a lista, aprovar, cancelar. Quem manda é `lote.ts` (o mesmo motor).
 * Estados e transições são os de `onda.ts` do Kommo: montando → montada → aprovada → concluida · pausada/cancelada de qualquer um.
 * A aprovação confere `total` + `impressao` (o hash do modelo, das variáveis e de cada pessoa com o nome que vai na saudação) como o painel do Kommo.
 */
import type { DisparoOnda, Prisma, Unit } from '@prisma/client';
import { prisma } from '../../prisma.js';
import { logger } from '../../logger.js';
import { CAIXAS_CLOUD, CAIXAS_REGUA } from '../../chatwoot-regua.js';
import { chatDoChatwoot } from '../../chatwoot-regua-worker.js';
import { contextoDaUnidade, contextoDoAmbiente, type ContextoChatwoot } from '../../../mcp-remoto/chatwoot.js';
import { conferenciaDaFranquia } from '../franquia.js';
import { impressaoDaOnda } from '../modelo.js';
import { BATIDA_DA_MONTAGEM_MS } from '../montagem.js';
import { falha, definicaoDaOnda, type ResultadoDeAcao } from '../onda.js';
import { problemaNoModelo } from '../regras.js';
import { conferirModeloDaOnda, type ConferenciaDoModelo } from './canal.js';
import { quemAprova, ajusteDaUnidade, type AjusteDaUnidade } from './ajuste.js';
import { DIAS_SEM_REPETIR_DISPARO, calcularPublico, situacaoPeloCrm, type DepsDoPublico, type PublicoCalculado } from './publico.js';
import { filtroSchema, resumoDoFiltro, type Filtro } from './filtro.js';
import { ultimoPedidoDeSaidaDoContato } from './mensagens.js';
import { estimativaDoDisparo, type EstimativaDeCusto } from './custo.js';
import { chaveDoLimiteDoCrm, modoDoDisparoNoCrm } from './porto.js';

export const ORIGEM_CRM = 'chatwoot';
/** Prefixo da recusa «custo desconhecido»: a tela reconhece e pede a confirmação explícita. */
export const PREFIXO_CUSTO_DESCONHECIDO = 'custo desconhecido';

/** O contexto (conta + token) da unidade no CRM, ou null. */
export function ctxDaUnidadeNoCrm(slug: string): ContextoChatwoot | null {
  const base = contextoDoAmbiente();
  return base ? contextoDaUnidade(base, slug) : null;
}

/** Tudo o que a leitura do público precisa do mundo, para ESTA unidade. Só leitura. */
export function depsDoPublico(unit: Unit, ctx: ContextoChatwoot): DepsDoPublico {
  const chat = chatDoChatwoot(ctx);
  const franquia = unit.spineToken ? conferenciaDaFranquia(unit) : null;
  return {
    pagina: (caixa, p) => chat.pagina(caixa, p),
    ultimaPublica: async (id) => (await chat.ultimaPublica(id))?.criadaEm ?? null,
    pediuSair: (c) => ultimoPedidoDeSaidaDoContato(ctx, c.id, c.contatoId, 3),
    recentes: async () => {
      const desde = new Date(Date.now() - DIAS_SEM_REPETIR_DISPARO * 86_400_000);
      const linhas = await prisma.disparoDestinatario.findMany({
        where: { unitId: unit.id, enviadoEm: { gte: desde }, estado: { in: ['enviando', 'enviado', 'falhou', 'saiu'] } },
        select: { chave: true },
      });
      return new Set(linhas.map((l) => l.chave));
    },
    // com agenda: a franquia, a mesma do motor (sem cartão, casa pelo nome inteiro). Sem agenda: a etapa do CRM.
    franquia: async (e, c) => (franquia ? franquia({ leadId: null, nomeCompleto: e.nomeCompleto, telefone: e.telefone }) : situacaoPeloCrm(c.attrs)),
    agora: () => new Date(),
  };
}

export interface ModeloEscolhido {
  nome: string;
  idioma: string;
  /** o corpo do modelo no CRM, com {{1}}… */
  texto: string;
  /** o que preenche cada {{n}}: "primeiroNome" | "unidade" | "texto:<literal>" */
  variaveis: string[];
  /** a categoria do modelo na Meta (MARKETING, UTILITY…): é por ela que se estima o custo */
  categoria?: string | null;
  /** o CRM não informou a categoria: foi assumida como marketing */
  categoriaAssumida?: boolean;
}

/** A caixa é desta unidade e é uma das de WhatsApp oficial (a configuração). A conferência do canal de verdade é no CRM. */
export function caixaDaUnidade(slug: string, caixa: number): string | null {
  if (CAIXAS_REGUA[caixa] !== slug) return `a caixa ${caixa} não é desta unidade`;
  if (!CAIXAS_CLOUD.has(caixa)) return `a caixa ${caixa} não está cadastrada como WhatsApp oficial nesta unidade`;
  return null;
}

/** Os estados em que uma onda do CRM ainda está viva: só UMA por unidade (o teto do número é um só e a mesma pessoa não pode entrar em duas). */
/** Quantas montagens de lista do CRM podem andar ao mesmo tempo, somando todas as unidades. */
export const MAX_MONTAGENS_DO_CRM = 2;
/** O teto do «máximo de pessoas» que a tela aceita (o padrão da tela é 50). */
export const MAXIMO_POR_DISPARO = 500;
/** Uma montagem que não bate há mais que isto (10 batidas) está órfã: é cancelada ao abrir outra, e não ocupa vaga. */
export const MONTAGEM_VIVA_MS = 10 * BATIDA_DA_MONTAGEM_MS;
const VIVA = ['montando', 'montada', 'aprovada', 'pausada'];

export async function abrirOndaChatwoot(args: {
  unit: Unit;
  conta: number;
  filtro: Filtro;
  modelo: ModeloEscolhido;
  /** o máximo de pessoas deste disparo (obrigatório): a lista é cortada nele na montagem */
  maximo: number;
  nome: string;
  por: string;
  ctx: ContextoChatwoot;
  conferirModelo?: (ctx: ContextoChatwoot, caixa: number, def: { template: string; idioma: string; textoModelo: string; variaveis: string[] }) => Promise<ConferenciaDoModelo>;
}): Promise<ResultadoDeAcao<DisparoOnda>> {
  const { unit, filtro, modelo } = args;
  if (!unit.isActive) return falha(404, 'unidade não encontrada');
  if (!Number.isInteger(args.maximo) || args.maximo < 1 || args.maximo > MAXIMO_POR_DISPARO) return falha(400, `o máximo de pessoas do disparo é obrigatório: de 1 a ${MAXIMO_POR_DISPARO}`);
  const nome = args.nome.trim().replace(/\s+/g, ' ');
  if (nome.length < 3 || nome.length > 80) return falha(400, 'dê um nome à campanha (3 a 80 letras)');
  const naoEDaUnidade = caixaDaUnidade(unit.slug, filtro.caixa);
  if (naoEDaUnidade) return falha(422, naoEDaUnidade);
  const problema = problemaNoModelo(modelo.texto, modelo.variaveis);
  if (problema) return falha(422, problema);
  const conf = await (args.conferirModelo ?? conferirModeloDaOnda)(args.ctx, filtro.caixa, { template: modelo.nome, idioma: modelo.idioma, textoModelo: modelo.texto, variaveis: modelo.variaveis });
  if (!conf.ok) return falha(conf.transitorio ? 502 : 422, conf.motivo);

  const slug = `cw-${unit.slug.replace(/^doutor-hernia-/, '').slice(0, 24)}-${Date.now().toString(36)}`;
  const r = await prisma.$transaction(async (tx) => {
    // DUAS travas: a global do teto de montagens (senão duas unidades juntas passam do teto, cada uma sob a trava só dela) e a da unidade
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('disparo-onda-crm:montagens'))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`disparo-onda-crm:${unit.id}`}))`;
    // a montagem ÓRFÃ (sem batida há 10 min: o processo caiu num deploy; uma batida atrasada não a mata) é cancelada AQUI, já: senão ela deixaria de contar no teto mas continuaria
    // «viva» para a trava da unidade (409) até os 30 min do vigia. Teto e trava da unidade enxergam o mesmo conjunto.
    await tx.disparoOnda.updateMany({ where: { origem: ORIGEM_CRM, estado: 'montando', atualizadoEm: { lt: new Date(Date.now() - MONTAGEM_VIVA_MS) } }, data: { estado: 'cancelada', pausaMotivo: 'a montagem foi interrompida (reinício do servidor?): monte o disparo de novo' } });
    const viva = await tx.disparoOnda.findFirst({ where: { unitId: unit.id, origem: ORIGEM_CRM, estado: { in: VIVA } }, select: { id: true, estado: true } });
    if (viva) return { viva };
    // o limite de montagens do CRM é PRÓPRIO (as do conector do Kommo têm o delas): cada montagem lê a caixa inteira do Chatwoot
    if ((await tx.disparoOnda.count({ where: { origem: ORIGEM_CRM, estado: 'montando' } })) >= MAX_MONTAGENS_DO_CRM) return { cheio: true as const };
    const campanha = await tx.disparoCampanha.create({
      data: { slug, nome, template: modelo.nome, idioma: modelo.idioma, textoModelo: modelo.texto, variaveis: modelo.variaveis as Prisma.InputJsonValue, porUnidade: {} },
    });
    const criada = await tx.disparoOnda.create({
      data: {
        campanhaId: campanha.id,
        unitId: unit.id,
        etiqueta: resumoDoFiltro(filtro),
        template: modelo.nome,
        idioma: modelo.idioma,
        textoModelo: modelo.texto,
        variaveis: modelo.variaveis as Prisma.InputJsonValue,
        estado: 'montando',
        impressao: '',
        criadaPor: args.por.slice(0, 120),
        origem: ORIGEM_CRM,
        maximoPessoas: args.maximo,
        categoriaModelo: modelo.categoria ?? null,
        categoriaAssumida: modelo.categoriaAssumida === true,
        contaChatwoot: args.conta,
        caixaChatwoot: filtro.caixa,
        filtro: filtro as unknown as Prisma.InputJsonValue,
      },
    });
    return { criada };
  });
  if ('cheio' in r && r.cheio) return falha(429, `já há ${MAX_MONTAGENS_DO_CRM} listas do CRM sendo montadas agora (cada uma lê a caixa inteira): espere alguns minutos`);
  if ('viva' in r && r.viva) return falha(409, `já existe um disparo desta unidade em andamento (${r.viva.estado}); termine ou cancele antes de montar outro`);
  return { ok: true, dados: r.criada! };
}

/**
 * Monta a lista de uma onda `montando`. Qualquer erro cancela a onda COM o motivo — nunca deixa meia lista aprovável.
 * `ler` é a porta para o CRM, as conversas e a franquia (o teste troca por uma de mentira).
 */
export async function concluirMontagemChatwoot(ondaId: string, ler?: (unit: Unit, filtro: Filtro) => Promise<PublicoCalculado>): Promise<void> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true } });
  if (!onda || onda.estado !== 'montando' || onda.origem !== ORIGEM_CRM) return;
  const unit = onda.unit;
  const batida = setInterval(() => void prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'montando' }, data: { atualizadoEm: new Date() } }).catch(() => undefined), BATIDA_DA_MONTAGEM_MS);
  batida.unref();
  try {
    const filtro = filtroSchema.parse(onda.filtro);
    const lido = ler
      ? await ler(unit, filtro)
      : await (async () => {
          const ctx = ctxDaUnidadeNoCrm(unit.slug);
          if (!ctx?.conta) throw new Error('a unidade não tem conta do CRM válida');
          return calcularPublico(filtro, depsDoPublico(unit, ctx), { completo: true });
        })();
    // O MÁXIMO: a lista é CORTADA aqui (ficam as primeiras, na ordem da caixa — a atividade mais recente primeiro); as que passam do máximo viram «acima do máximo». O motor só manda a quem está na lista.
    const maximo = onda.maximoPessoas ?? MAXIMO_POR_DISPARO;
    const acima = Math.max(0, lido.elegiveis.length - maximo);
    const elegiveis = acima ? lido.elegiveis.slice(0, maximo) : lido.elegiveis;
    const fora = acima ? { ...lido.fora, 'acima-do-maximo': acima } : lido.fora;
    const resumo = { candidatos: lido.noFiltro, lidas: lido.lidas, truncada: lido.truncada, fora, montadaEm: new Date().toISOString() };
    if (elegiveis.length === 0) {
      await prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'montando' }, data: { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível com este filtro', resumo } });
      return;
    }
    await prisma.disparoDestinatario.createMany({
      data: elegiveis.map((e) => ({
        ondaId, campanhaId: onda.campanhaId, unitId: unit.id, telefone: e.telefone, chave: e.chave, nome: e.nome, nomeCompleto: e.nomeCompleto || null,
        conversaChatwoot: e.conversaId, contatoChatwoot: e.contatoId,
      })),
      skipDuplicates: true,
    });
    const pessoas = await prisma.disparoDestinatario.findMany({ where: { ondaId }, select: { chave: true, nome: true } });
    // Só sai de `montando` se ninguém cancelou enquanto o CRM e a franquia respondiam: onda cancelada NUNCA volta a ser aprovável.
    const fechou = await prisma.disparoOnda.updateMany({
      where: { id: ondaId, estado: 'montando' },
      data: { estado: 'montada', total: pessoas.length, resumo, impressao: impressaoDaOnda(definicaoDaOnda(onda), pessoas) },
    });
    if (fechou.count !== 1) {
      logger.warn({ onda: ondaId }, 'disparo-crm: a onda foi cancelada durante a montagem — fica cancelada');
      return;
    }
    logger.info({ onda: ondaId, unit: unit.slug, total: pessoas.length, fora }, 'disparo-crm: onda montada, esperando aprovação');
  } catch (err) {
    logger.error({ err: String(err), onda: ondaId }, 'disparo-crm: montagem da onda falhou');
    await prisma.disparoOnda
      .updateMany({ where: { id: ondaId, estado: 'montando' }, data: { estado: 'cancelada', pausaMotivo: `montagem falhou: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) } })
      .catch(() => undefined);
  } finally {
    clearInterval(batida);
  }
}

/**
 * Uma aprovação por onda. Vale só se: quem aprova pode (administrador da Doutor Digital; a administradora da clínica só se o ajuste da unidade
 * deixar), a pessoa viu EXATAMENTE esta lista e este texto (`total` e `impressao` batem com o banco agora) e o CRM confirma o modelo na caixa.
 */
export async function aprovarOndaChatwoot(
  ondaId: string,
  args: { email: string | null | undefined; papel: string | null | undefined; total: unknown; impressao: unknown; maximo?: unknown; confirmarCustoDesconhecido?: unknown },
  deps: { conferir?: typeof conferirModeloDaOnda; ctx?: (slug: string) => ContextoChatwoot | null; ajuste?: (unitId: string) => Promise<AjusteDaUnidade>; estimar?: (o: { unitId: string; categoriaModelo: string | null; total: number; categoriaAssumida: boolean }) => Promise<EstimativaDeCusto> } = {},
): Promise<ResultadoDeAcao<DisparoOnda>> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true } });
  if (!onda || onda.origem !== ORIGEM_CRM) return falha(404, 'disparo não encontrado');
  const quem = quemAprova({ email: args.email, papel: args.papel }, await (deps.ajuste ?? ajusteDaUnidade)(onda.unitId));
  if (!quem.ok) return falha(403, quem.motivo);
  if (onda.estado !== 'montada') return falha(409, `o disparo está "${onda.estado}"; só se aprova um disparo montado`);
  if (modoDoDisparoNoCrm(onda.unit.slug) === 'desligado') return falha(422, 'os disparos estão DESLIGADOS nesta unidade: ligue (ou deixe em seco) antes de aprovar');

  const pessoas = await prisma.disparoDestinatario.findMany({ where: { ondaId, estado: 'pendente' }, select: { chave: true, nome: true } });
  const agora = impressaoDaOnda(definicaoDaOnda(onda), pessoas);
  if (pessoas.length !== onda.total || agora !== onda.impressao || args.total !== onda.total || args.impressao !== onda.impressao) {
    return falha(409, 'a lista ou o texto mudou desde que você abriu a tela; recarregue e confira de novo');
  }
  // O MÁXIMO de pessoas: a aprovação o confere junto com total e impressão (a tela mostrou este número) e a lista nunca o passa.
  if (onda.maximoPessoas == null) return falha(409, 'este disparo foi montado antes de existir o máximo de pessoas; monte-o de novo, dizendo o máximo');
  if (args.maximo !== onda.maximoPessoas) return falha(409, 'o máximo de pessoas deste disparo mudou ou não foi conferido; recarregue a tela e confira de novo');
  if (pessoas.length > onda.maximoPessoas) return falha(409, `a lista (${pessoas.length}) passa do máximo de ${onda.maximoPessoas} pessoas: monte o disparo de novo`);
  // O CUSTO: conhecido, a tela o mostrou; DESCONHECIDO, só aprova quem confirma explicitamente que aceita (a mensagem diz porquê).
  const custo = await (deps.estimar ?? ((o) => estimativaDoDisparo(o.unitId, o.categoriaModelo, o.total, o.categoriaAssumida)))({ unitId: onda.unitId, categoriaModelo: onda.categoriaModelo, total: onda.total, categoriaAssumida: onda.categoriaAssumida });
  if (!custo.conhecido && args.confirmarCustoDesconhecido !== true) return falha(409, `${PREFIXO_CUSTO_DESCONHECIDO}: ${custo.nota}. Para aprovar mesmo assim, confirme explicitamente.`);
  const ctx = (deps.ctx ?? ctxDaUnidadeNoCrm)(onda.unit.slug);
  if (!ctx?.conta || ctx.conta.conta !== onda.contaChatwoot || onda.caixaChatwoot == null) return falha(422, 'a unidade não tem a conta do CRM deste disparo');
  const conf = await (deps.conferir ?? conferirModeloDaOnda)(ctx, onda.caixaChatwoot, { template: onda.template, idioma: onda.idioma, textoModelo: onda.textoModelo, variaveis: (onda.variaveis as unknown[]).map(String), categoria: onda.categoriaModelo, categoriaAssumida: onda.categoriaAssumida });
  if (!conf.ok) return falha(conf.transitorio ? 502 : 422, conf.motivo);

  const r = await prisma.disparoOnda.updateMany({
    where: { id: ondaId, estado: 'montada' },
    data: { estado: 'aprovada', aprovadaPor: String(args.email).trim().toLowerCase(), aprovadaEm: new Date(), aprovadaModo: modoDoDisparoNoCrm(onda.unit.slug) },
  });
  if (r.count !== 1) return falha(409, 'o disparo mudou de estado enquanto aprovava');
  await prisma.disparoLimite.deleteMany({ where: { unitId: chaveDoLimiteDoCrm(onda.unitId) } }).catch((err) => logger.warn({ err: String(err), onda: ondaId }, 'disparo-crm: aprovei, mas não consegui zerar o contador de limite de taxa'));
  logger.warn({ onda: ondaId, unit: onda.unit.slug, total: onda.total, maximo: onda.maximoPessoas, custoBrl: custo.brl, custoConhecido: custo.conhecido, por: args.email, como: quem.como }, 'disparo-crm: onda APROVADA');
  return { ok: true, dados: (await prisma.disparoOnda.findUnique({ where: { id: ondaId } }))! };
}
