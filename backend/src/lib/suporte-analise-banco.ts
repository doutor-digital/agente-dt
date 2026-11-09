/**
 * Análise automática do menu de suporte — as dependências de verdade (banco, Kommo só leitura, OpenAI, Telegram, WhatsApp).
 * A regra mora em `suporte-analise.ts`.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { mascararPii } from './pii.js';
import { enviarTelegramChamados } from './telegram.js';
import { AUTOMACOES } from './automacoes.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { criarEnviadorEvolution, lerConfig as lerConfigDoMenu } from './suporte-menu.js';
import {
  analisarDemanda,
  lerConfigAnalise,
  linksDeCartao,
  perguntarIa,
  semPii,
  type ConfigAnalise,
  type Contexto,
  type DemandaParaAnalise,
  type DepsAnalise,
  type DesfechoAnalise,
} from './suporte-analise.js';
import { unidadesCitadas, type Verificacao } from './suporte-menu-maquina.js';

const H = 60 * 60_000;
const MAX_CAMPOS = 30;
const MAX_BASE_CHARS = 8_000;

function automacoesDa(slug: string): { ligadas: string[]; noPapel: string[] } {
  const ligadas: string[] = [];
  const noPapel: string[] = [];
  for (const a of AUTOMACOES) {
    const e = estadoDaAutomacao(slug, a.id, process.env[a.chave]);
    if (e === 'ligado') ligadas.push(a.nome);
    else if (e === 'seco') noPapel.push(a.nome);
  }
  return { ligadas, noPapel };
}

async function errosDa(unitId: string | null, agora: Date, take: number) {
  const grupos = await prisma.systemLog.groupBy({
    by: ['level', 'msg'],
    where: { createdAt: { gte: new Date(agora.getTime() - 48 * H) }, ...(unitId ? { unitId } : {}) },
    _count: { _all: true },
    orderBy: { _count: { msg: 'desc' } },
    take,
  });
  return grupos.map((g) => ({ nivel: String(g.level), msg: mascararPii(g.msg).slice(0, 200), vezes: g._count._all }));
}

async function coletar(d: DemandaParaAnalise, agora: Date): Promise<Contexto> {
  const ctx: Contexto = { unidade: null, automacoes: null, erros: [], cartoes: [], conhecimento: [], unidadesCitadas: [] };

  // base de conhecimento (editada no painel), até ~8 mil caracteres
  let total = 0;
  for (const k of await prisma.suporteConhecimento.findMany({ where: { ativo: true }, orderBy: { atualizadoEm: 'desc' } })) {
    const texto = k.texto.slice(0, 2_000);
    if (total + texto.length > MAX_BASE_CHARS) break;
    total += texto.length;
    ctx.conhecimento!.push({ titulo: k.titulo, texto });
  }

  const unit = d.unidadeSlug ? await prisma.unit.findUnique({ where: { slug: d.unidadeSlug } }) : null;
  if (unit) {
    ctx.unidade = { slug: unit.slug, nome: unit.name, ativa: unit.isActive, temKommo: Boolean(unit.kommoSubdomain && unit.kommoAccessToken) };
    ctx.automacoes = automacoesDa(unit.slug);
  }

  // erros das últimas 48 h (da unidade, se conhecida; senão da rede), agrupados pela mensagem
  ctx.erros = await errosDa(unit?.id ?? null, agora, 12);

  // outras unidades citadas no relato ("Tatuí, Boa Vista e Salto"): automações e erros de cada uma
  const ativas = await prisma.unit.findMany({ where: { isActive: true }, select: { id: true, slug: true, name: true } });
  const citadas = unidadesCitadas(d.relato, ativas.map((u) => ({ slug: u.slug, nome: u.name }))).filter((u) => u.slug !== unit?.slug);
  for (const c of citadas) {
    const id = ativas.find((u) => u.slug === c.slug)!.id;
    ctx.unidadesCitadas!.push({ slug: c.slug, nome: c.nome, automacoes: automacoesDa(c.slug), erros: await errosDa(id, agora, 6) });
  }

  // cartões citados no relato (só leitura; cliente "sem freio": um 403/429 aqui nunca trava o Kommo da Sofia)
  for (const l of linksDeCartao(d.relato)) {
    const link = `${l.subdominio}.kommo.com/leads/detail/${l.leadId}`;
    try {
      const conta = await prisma.unit.findFirst({ where: { kommoSubdomain: l.subdominio, kommoAccessToken: { not: null } } });
      if (!conta) {
        ctx.cartoes.push({ link, erro: 'conta Kommo não cadastrada no agente' });
        continue;
      }
      const lead = await createKommoClientSemFreio(conta).getLead(l.leadId);
      const campos = (lead.custom_fields_values ?? []).slice(0, MAX_CAMPOS).map((c) => ({
        campo: c.field_name,
        valor: (c.values ?? []).map((v) => String(v.value ?? '')).join(', ').slice(0, 120),
      }));
      ctx.cartoes.push({
        link,
        resumo: semPii({
          unidade: conta.slug,
          funil: lead.pipeline_id,
          etapa: lead.status_id,
          atualizadoEm: lead.updated_at ? new Date(lead.updated_at * 1000).toISOString() : null,
          etiquetas: (lead._embedded?.tags ?? []).map((t) => t.name),
          campos,
        }),
      });
    } catch (err) {
      ctx.cartoes.push({ link, erro: String(err instanceof Error ? err.message : err).slice(0, 160) });
    }
  }
  return ctx;
}

export function depsReais(cfg: ConfigAnalise): DepsAnalise {
  return {
    agora: () => new Date(),

    async reservar(protocolo) {
      const r = await prisma.suporteDemanda.updateMany({ where: { protocolo, analiseIniciadaEm: null }, data: { analiseIniciadaEm: new Date() } });
      if (r.count !== 1) return null;
      const d = await prisma.suporteDemanda.findUnique({ where: { protocolo } });
      if (!d) return null;
      return {
        protocolo: d.protocolo,
        jid: d.jid,
        nome: d.nome,
        unidadeSlug: d.unidadeSlug,
        verificacao: d.verificacao as Verificacao,
        categoriaNome: d.categoriaNome,
        relato: d.relato,
      };
    },

    analisesNasUltimas24h: () => prisma.suporteDemanda.count({ where: { analiseIniciadaEm: { gte: new Date(Date.now() - 24 * H) } } }),

    coletar: (d) => coletar(d, new Date()),

    perguntar: (d, ctx) => perguntarIa(d, ctx, cfg),

    async gravar(protocolo, { analise, motivoFalha, prazo }) {
      await prisma.suporteDemanda.update({
        where: { protocolo },
        data: {
          analise: analise ? (analise as unknown as object) : undefined,
          analiseFalha: motivoFalha,
          prioridade: analise?.prioridade ?? null,
          prazoEm: prazo,
        },
      });
    },

    telegram: (texto) => enviarTelegramChamados(texto),

    async responderPessoa(jid, texto) {
      // só responde se o MENU também estiver ligado, e dentro do teto diário de respostas dele
      const menu = lerConfigDoMenu();
      if (menu.modo !== 'ligado') return false;
      const respostas = await prisma.suporteEnvio.count({ where: { enviadoEm: { gte: new Date(Date.now() - 24 * H) } } });
      if (respostas >= menu.respostasPorDia) {
        logger.warn('suporte-analise: teto diário de respostas do menu atingido — o prazo não foi enviado à pessoa');
        return false;
      }
      const ok = await criarEnviadorEvolution(menu)(jid, texto);
      if (ok) await prisma.suporteEnvio.create({ data: { jid, nova: false } });
      return ok;
    },
  };
}

/** Dispara a análise de uma demanda recém-aberta (não espera; nunca lança). */
export function dispararAnalise(protocolo: number, cfg: ConfigAnalise = lerConfigAnalise()): Promise<DesfechoAnalise | null> {
  return analisarDemanda(protocolo, cfg, depsReais(cfg))
    .then((r) => {
      logger.info({ protocolo, acao: r.acao }, 'suporte-analise: terminou');
      return r;
    })
    .catch((err: unknown) => {
      logger.error({ protocolo, err: String(err) }, 'suporte-analise: erro inesperado');
      return null;
    });
}
