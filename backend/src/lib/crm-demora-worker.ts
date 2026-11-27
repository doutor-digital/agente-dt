/**
 * O worker `crm-demora` (automação `chatwoot-demora`): a cada minuto vê quem está esperando a equipe responder e deixa `crm-demora/ciclo.ts` decidir
 * (mensagem de espera ao paciente, WhatsApp à SDR e à gerente). Aqui só estão as ligações com o mundo de verdade: o banco (a trava «uma vez só» é a
 * UNIQUE de `chatwoot_regua_disparo`), o Chatwoot DA CONTA DA UNIDADE (nunca o de outra) e o WhatsApp da atendente (a instância dos avisos,
 * `EVOLUTION_ALERT_*`, com os números de `crm_tarefa_zap`).
 *
 * Modo por unidade (tela de automações): desligado = o robô não lê nem anota nada (só apaga o marcador «ligado desde» das caixas); SECO (de fábrica em
 * toda conta) = decide e só anota «mandaria…» no banco, sem escrever no paciente, no CRM nem no WhatsApp de ninguém (e também apaga o marcador);
 * ligado = faz.
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { fusoDaUnidade } from './fuso.js';
import { enviarPelaEvolutionComResultado } from './alerta-whatsapp.js';
import { chamar, contaChatwootDoAmbiente, contextoDaCaixa, contextoDoAmbiente, ehContaDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_CLOUD, CAIXAS_REGUA, GERENTE_DA_CAIXA } from './chatwoot-regua.js';
import { configDaUnidade } from './chatwoot-unidades.js';
import { ID_IA } from './chatwoot-ia.js';
import { portaDoRobo, tokenDoRobo } from './chatwoot-sofia-bot.js';
import { ultimoPedidoDeSaidaDoContato } from './disparo/chatwoot/mensagens.js';
import { modoDaDemora } from './crm-demora/gerente.js';
import { ID_CICLO, novaMemoriaDaDemora, rodarCicloDaDemora, type Armazem, type MundoDaDemora, type UnidadeDaDemora } from './crm-demora/ciclo.js';

const CICLO_MS = Number(process.env.CRM_DEMORA_CICLO_MS) || 60_000;
const PRIMEIRO_CICLO_MS = 100_000;
/** 25 conversas por página, as mais novas primeiro; a leitura para na 1ª página inteira mais velha que a janela. 20 páginas = 500 conversas ativas na janela de 200 min (uma caixa não chega nem perto; se chegar, o log avisa). */
const MAX_PAGINAS = 20;
const PAGINAS_DE_MENSAGENS = 2;

export { modoDaDemora };

/** O token do robô da Sofia DESTA conta (a do ambiente usa o global; clínica de conta própria, o dela); null = sem robô. */
function tokenDoRoboDaConta(conta: number | undefined, slug: string): string | null {
  return conta !== undefined && ehContaDoAmbiente(conta) ? tokenDoRobo() : tokenDoRobo(process.env, configDaUnidade(slug)?.envSufixo);
}
function tokenDoRoboDaUnidade(slug: string, base: ContextoChatwoot | null): string | null {
  const caixa = Object.entries(CAIXAS_REGUA).find(([, s]) => s === slug)?.[0];
  const conta = base && caixa ? contextoDaCaixa(base, Number(caixa))?.conta?.conta : undefined;
  return tokenDoRoboDaConta(conta, slug);
}

/** A unidade muda raramente: relida a cada 10 min, não a cada minuto. */
const unidades = new Map<string, { ate: number; unit: Awaited<ReturnType<typeof prisma.unit.findUnique>> }>();
async function unidadeEmMemoria(slug: string) {
  const g = unidades.get(slug);
  if (g && g.ate > Date.now()) return g.unit;
  const unit = await prisma.unit.findUnique({ where: { slug } });
  unidades.set(slug, { ate: Date.now() + 10 * 60_000, unit });
  return unit;
}

export function armazemDoBanco(): Armazem {
  return {
    async registrar(l) {
      try {
        await prisma.chatwootReguaDisparo.create({ data: l });
        return true;
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') return false;
        throw err;
      }
    },
    async desfazer(l) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { caixa: l.caixa, conversationId: l.conversationId, regra: l.regra, chave: l.chave } });
    },
    async ligadoDesde(caixa, agora) {
      // a «conversa 0» é o marcador da caixa (como a régua faz com CAMPO_PARTIDA): quando a automação foi vista ligada pela primeira vez
      const onde = { caixa, conversationId: 0, regra: 'demora-ligado-desde', chave: 'v1' };
      const ja = await prisma.chatwootReguaDisparo.findFirst({ where: onde, select: { criadoEm: true } });
      if (ja) return ja.criadoEm;
      try {
        const c = await prisma.chatwootReguaDisparo.create({ data: { ...onde, modo: 'ligado', texto: `ligado visto pela primeira vez em ${agora.toISOString()}` }, select: { criadoEm: true } });
        return c.criadoEm;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'P2002') throw err;
        const de_novo = await prisma.chatwootReguaDisparo.findFirst({ where: onde, select: { criadoEm: true } });
        return de_novo?.criadoEm ?? agora;
      }
    },
    async esquecerLigado(caixa) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { caixa, conversationId: 0, regra: 'demora-ligado-desde' } });
    },
    async numeroDoAgente(conta, agenteId) {
      const z = await prisma.crmTarefaZap.findUnique({ where: { conta_agenteId: { conta, agenteId } } });
      return z ? { telefone: z.telefone, nome: z.agenteNome } : null;
    },
  };
}

async function paginaDeMensagens(ctx: ContextoChatwoot, id: number, antes?: number): Promise<any[]> {
  const r = (await chamar(ctx, 'GET', `conversations/${id}/messages`, { query: antes ? { before: String(antes) } : {}, baixa: true, origem: 'crm-demora' })) as { payload?: unknown[] } | null;
  return Array.isArray(r?.payload) ? r.payload : [];
}

export function mundoReal(): MundoDaDemora {
  return {
    async unidades() {
      const porSlug = new Map<string, number[]>();
      for (const [caixa, slug] of Object.entries(CAIXAS_REGUA)) porSlug.set(slug, [...(porSlug.get(slug) ?? []), Number(caixa)]);
      const base = contextoDoAmbiente();
      const saida: UnidadeDaDemora[] = [];
      for (const [slug, caixas] of porSlug) {
        const modo = modoDaDemora(slug);
        // a desligada também vem: o ciclo só apaga o marcador «ligado desde» dela (religar não pode herdar o marcador velho) e não lê nada
        const iaLigada = estadoDaAutomacao(slug, ID_IA, process.env.CHATWOOT_IA_SLUGS) === 'ligado';
        const unit = await unidadeEmMemoria(slug);
        if (!unit) continue;
        saida.push({
          slug,
          nome: unit.name,
          fuso: fusoDaUnidade(unit),
          modo,
          iaLigada,
          // Sofia ligada e SEM o robô do CRM nesta conta: ela fala pelo conector, o mesmo usuário das nossas mensagens
          conectorEhSofia: iaLigada && !tokenDoRoboDaUnidade(slug, base),
          // o Chatwoot da CONTA da caixa (cada clínica tem a sua); as caixas de uma unidade moram na mesma conta
          ctx: base && caixas[0] !== undefined ? contextoDaCaixa(base, caixas[0]) : null,
          caixas: caixas.map((id) => ({ id, oficial: CAIXAS_CLOUD.has(id), gerente: GERENTE_DA_CAIXA[id] ?? null })),
        });
      }
      return saida;
    },
    async listar(ctx, caixa, desdeSeg) {
      const todas: any[] = [];
      const vistas = new Set<number>();
      for (const status of ['open', 'pending']) {
        for (let p = 1; p <= MAX_PAGINAS; p++) {
          const r = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(caixa), status, assignee_type: 'all', page: String(p) }, baixa: true, origem: 'crm-demora' })) as
            | { data?: { payload?: unknown[] }; payload?: unknown[] }
            | null;
          const pagina = (r?.data?.payload ?? r?.payload ?? []) as any[];
          if (!Array.isArray(pagina) || pagina.length === 0) break;
          for (const c of pagina) {
            const id = Number(c?.id);
            if (Number.isInteger(id) && !vistas.has(id) && Number(c?.last_activity_at) >= desdeSeg) {
              vistas.add(id);
              todas.push(c);
            }
          }
          // da mais nova para a mais velha: a página inteira antes do corte = acabou
          if (pagina.every((c) => Number(c?.last_activity_at) < desdeSeg)) break;
          if (p === MAX_PAGINAS) logger.warn({ caixa, status }, `${ID_CICLO}: a caixa tem mais conversas ativas do que ${MAX_PAGINAS} páginas — as mais antigas da janela não foram lidas neste ciclo`);
        }
      }
      return todas;
    },
    conversa: (ctx, id) => chamar(ctx, 'GET', `conversations/${id}`, { baixa: true, origem: 'crm-demora' }),
    async mensagens(ctx, id) {
      // o Chatwoot devolve as 20 mais novas em ordem crescente; `before=<id>` traz as 20 anteriores
      let todas: any[] = await paginaDeMensagens(ctx, id);
      for (let i = 1; i < PAGINAS_DE_MENSAGENS && todas.length >= 20; i++) {
        const primeiro = Number(todas[0]?.id);
        if (!Number.isInteger(primeiro) || primeiro <= 0) break;
        const antes = await paginaDeMensagens(ctx, id, primeiro);
        if (antes.length === 0) break;
        todas = [...antes, ...todas];
      }
      return todas;
    },
    async conector(ctx) {
      // quem é o dono do token desta conta (`/api/v1/profile`, fora do caminho da conta)
      const conta = ctx.conta;
      if (!conta) return null;
      const r = await ctx.fetch(`${conta.url}/api/v1/profile`, { headers: { api_access_token: conta.token, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const id = Number(((await r.json().catch(() => null)) as { id?: unknown } | null)?.id);
      return Number.isInteger(id) && id > 0 ? id : null;
    },
    pediuSair: (ctx, conversaId, contatoId) => ultimoPedidoDeSaidaDoContato(ctx, conversaId, contatoId, 3),
    async mandarEspera(u, ctx, conversaId, texto) {
      // pelo robô da Sofia quando ele existe nesta conta: não é «usuário», então não conta como a 1ª resposta HUMANA nos relatórios de tempo de resposta do CRM
      // (o `waiting_since` é zerado do mesmo jeito por qualquer saída — por isso a espera é contada pelas mensagens, ver regras.ts)
      const token = tokenDoRoboDaConta(ctx.conta?.conta, u.slug);
      const robo = token ? portaDoRobo(ctx, token) : null;
      if (robo) {
        const r = await robo.publica(conversaId, texto, { demora_espera: true }); // a mesma marca do caminho do conector: o CRM rotula «mensagem automática»
        return { id: r.mensagem ?? null };
      }
      const r = (await chamar(ctx, 'POST', `conversations/${conversaId}/messages`, {
        corpo: { content: texto, message_type: 'outgoing', private: false, content_attributes: { demora_espera: true } },
      })) as { id?: unknown } | null;
      const id = Number(r?.id);
      return { id: Number.isInteger(id) && id > 0 ? id : null };
    },
    async nota(ctx, conversaId, texto) {
      await chamar(ctx, 'POST', `conversations/${conversaId}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: true } });
    },
    async zap(numero, texto) {
      const { EVOLUTION_ALERT_URL: url, EVOLUTION_ALERT_HEADER: header, EVOLUTION_ALERT_VALUE: valor } = process.env;
      if (!url || !header || !valor) return 'recusado'; // canal dos alertas não configurado: não saiu e não vai sair sozinho
      return enviarPelaEvolutionComResultado({ url, header, valor, numero, texto });
    },
    agora: () => new Date(),
    pausa: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
/**
 * Memória do processo (marcador «ligado desde», «já apaguei o marcador», esperas…). Recomeça a cada start/stop: o supervisor do lease para os workers
 * quando outra cópia vira líder e liga de novo quando esta volta — sem zerar, esta cópia reusaria o marcador VELHO de antes e mandaria a fila do
 * intervalo de uma vez.
 */
let memoria = novaMemoriaDaDemora();
/** Só para teste. */
export const memoriaDoWorker = () => memoria;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    await rodarCicloDaDemora({ armazem: armazemDoBanco(), mundo: mundoReal(), memoria });
  } catch (err) {
    logger.warn({ err: String(err) }, `${ID_CICLO}: o ciclo falhou — tento no próximo`);
  } finally {
    rodando = false;
  }
}

export function startCrmDemoraWorker(): void {
  if (timer) return;
  memoria = novaMemoriaDaDemora();
  if (!contaChatwootDoAmbiente()) {
    logger.info(`${ID_CICLO}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  primeira = setTimeout(() => void varrer(), PRIMEIRO_CICLO_MS);
  timer = setInterval(() => void varrer(), CICLO_MS);
  logger.info(`${ID_CICLO}: worker iniciado`);
}

export function stopCrmDemoraWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
  memoria = novaMemoriaDaDemora();
}
