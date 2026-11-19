/**
 * A aba «Automações» da tela «Robôs» do Chatwoot (pedido do João, 14/11/2026: "tudo que roda no CRM", "trazer a tela de Automações do console"):
 * o que roda no CRM por unidade, agrupado — Sofia · Agenda · Mensagens · Rastreio · Organização · Avisos para a equipe — com o estado da
 * unidade e, para as que têm chave no catálogo (`automacoes.ts`), o seletor de 3 estados (Ligada / Só no papel / Desligada).
 *
 * TRÊS ORIGENS, e a tela diz qual é qual (nada inventado):
 *  1. CATÁLOGO (`automacoes.ts`): as seis `chatwoot-*` e os comportamentos da Sofia que valem também no caminho do Chatwoot. Estado real da
 *     unidade (`unit_automacoes`, com o `.env` como padrão); o administrador do Chatwoot muda pelo MESMO caminho do console
 *     (`gravarEstadoDaAutomacao`, mesmo registro de quem mudou), em vez do super admin do console.
 *  2. FIXAS, SOMENTE LEITURA: o que existe no CRM mas é um interruptor GLOBAL do servidor (atalhos, campos obrigatórios ao resolver,
 *     etiqueta/nota do anúncio, Sofia como robô) ou não tem interruptor nenhum (pausa ao responder pelo celular, botões «Perdido: motivo»).
 *     O estado de quem tem interruptor é lido do mesmo ambiente que o código lê — «controlado pela Doutor Digital». Pôr chave por unidade
 *     nessas exigiria levar a unidade até pontos que hoje não a conhecem (script do menu, ponte do webhook): fica para quando houver pedido.
 *  3. NATIVAS DO CHATWOOT (Configurações → Automação): listadas pelo controller, só leitura, com o link para a tela nativa.
 *
 * Os comportamentos da Sofia listados aqui foram conferidos no CÓDIGO como parte do caminho do Chatwoot (o prompt é montado por
 * `composeSystemPromptForUnit`, a resposta passa por `aplicarGuardrail`); os que só valem no Kommo (sofia-calada, calar-paciente-em-tratamento,
 * pausa-equipe, sem-carinha, teto-mensal, cache-conversa, exame-de-imagem…) ficam de fora de propósito — o teste fixa as duas listas.
 */
import { prisma } from './prisma.js';
import { automacaoPorId, type Automacao } from './automacoes.js';
import { ehEstado, gravarEstadoDaAutomacao, panoramaDaUnidade, type Estado } from './automacoes-estado.js';
import { podeMexerNosRobos } from './robos-estado.js';
import { tokenDoRobo } from './chatwoot-sofia-bot.js';

export type GrupoDaAutomacao = 'sofia' | 'agenda' | 'mensagens' | 'rastreio' | 'organizacao' | 'avisos' | 'nativas';

export const ROTULO_DO_GRUPO_AUTO: Readonly<Record<GrupoDaAutomacao, string>> = {
  sofia: 'Sofia',
  agenda: 'Agenda',
  mensagens: 'Mensagens',
  rastreio: 'Rastreio',
  organizacao: 'Organização',
  avisos: 'Avisos para a equipe',
  nativas: 'Regras automáticas do CRM',
};
export const ORDEM_DOS_GRUPOS: readonly GrupoDaAutomacao[] = ['sofia', 'agenda', 'mensagens', 'rastreio', 'organizacao', 'avisos', 'nativas'];

/** As automações do catálogo que aparecem na tela e em que grupo. Só estas podem ser mudadas por aqui. */
export const DO_CATALOGO: Readonly<Record<string, GrupoDaAutomacao>> = {
  // o caminho do Chatwoot
  'chatwoot-ia': 'sofia',
  'chatwoot-agenda': 'agenda',
  'chatwoot-regua': 'mensagens',
  // `chatwoot-disparo`, `chatwoot-tarefas` e `chatwoot-demora` NÃO estão aqui de propósito: ligar o disparo em massa, a mensagem agendada e a mensagem de espera que saem sozinhas é decisão da Doutor Digital (console), nunca da administradora da clínica pela tela Robôs
  'chatwoot-capi': 'rastreio',
  'chatwoot-origem': 'rastreio',
  'chatwoot-duplicados': 'organizacao',
  // comportamentos da Sofia que valem também no Chatwoot (conferidos no código: composeSystemPromptForUnit / aplicarGuardrail)
  'conduzir-direto': 'sofia',
  'nome-na-hora-de-marcar': 'sofia',
  'sem-pergunta-de-alerta': 'sofia',
  'preco-convenio': 'sofia',
  'sorriso-colorido': 'sofia',
  'encerramento-pergunta-motivo': 'sofia',
  'prompt-da-unidade': 'sofia',
};

/** Do catálogo da Sofia que NÃO vale no caminho do Chatwoot (o teste confere que o código do Chatwoot não os usa). */
export const SO_NO_KOMMO: readonly string[] = ['sofia-calada', 'calar-paciente-em-tratamento', 'calar-cliente-do-escritorio', 'ia-so-numeros-de-teste', 'pausa-equipe', 'sem-carinha', 'teto-mensal', 'cache-conversa', 'exame-de-imagem-pausa-alerta', 'cache-agenda'];

/** «Não tem volta»: o que a automação faz não se desfaz (junta e apaga contato; manda dado para a Meta). Pede confirmação explícita para LIGAR. */
export function semVolta(a: Pick<Automacao, 'pegadinha' | 'risco'>): boolean {
  return /N[ÃA]O TEM VOLTA/i.test(a.pegadinha ?? '') || a.risco === 'manda-dado-externo';
}

export interface FixaSomenteLeitura {
  id: string;
  grupo: GrupoDaAutomacao;
  nome: string;
  oQueFaz: string;
  /** como o estado é lido do ambiente (a mesma expressão do código); null = não tem interruptor: sempre ligado */
  estado: ((env: NodeJS.ProcessEnv) => boolean) | null;
  /** o nome da variável (só para quem for ler o código) */
  variavel?: string;
}

export const FIXAS: readonly FixaSomenteLeitura[] = [
  { id: 'fixa-sofia-robo', grupo: 'sofia', nome: 'Sofia como robô do CRM (aba Pendentes)', oQueFaz: 'A Sofia responde como o robô (bot) do CRM: a conversa em que ela não respondeu sai de «Pendentes» e a atendente vê quem é o robô.', estado: (e) => String(e.CHATWOOT_SOFIA_COMO_BOT ?? '').trim() === '1', variavel: 'CHATWOOT_SOFIA_COMO_BOT' },
  { id: 'fixa-sofia-atendendo', grupo: 'sofia', nome: 'Conversa nova em «Abertas» com a etiqueta «sofia-atendendo»', oQueFaz: 'Com a Sofia como robô, a conversa nova vai para «Abertas» logo na 1ª mensagem e leva a etiqueta roxa «sofia-atendendo» enquanto a IA conversa. A etiqueta sai quando a equipe responde (CRM ou celular), quando a Sofia passa para a equipe ou quando a conversa é resolvida.', estado: (e) => tokenDoRobo(e) !== null && String(e.CHATWOOT_SOFIA_ATENDENDO ?? '').trim() !== '0', variavel: 'CHATWOOT_SOFIA_ATENDENDO' },
  { id: 'fixa-pausa-celular', grupo: 'sofia', nome: 'A Sofia cala quando a equipe responde (inclusive pelo celular)', oQueFaz: 'Se alguém da equipe respondeu depois da última mensagem do paciente, a Sofia não responde por cima. A resposta pelo celular da unidade recebe a etiqueta «respondeu-pelo-celular».', estado: null },
  { id: 'fixa-resolver', grupo: 'organizacao', nome: 'Campos obrigatórios ao resolver a conversa', oQueFaz: 'Ao clicar em «Resolver», o CRM pede os campos que faltam no cartão (motivo, etapa…) antes de fechar a conversa.', estado: (e) => e.CHATWOOT_RESOLVER_OBRIGATORIO !== '0', variavel: 'CHATWOOT_RESOLVER_OBRIGATORIO' },
  { id: 'fixa-guia-etapa', grupo: 'organizacao', nome: 'Guia «O que fazer agora» na conversa (com a aula em vídeo)', oQueFaz: 'No painel da direita da conversa, os passos da Etapa atual e o botão da aula, que abre o vídeo por cima da conversa sem sair do CRM. As caixinhas dos passos são só visuais: não gravam nada.', estado: (e) => e.CHATWOOT_GUIA_ETAPA !== '0', variavel: 'CHATWOOT_GUIA_ETAPA' },
  { id: 'fixa-atalhos', grupo: 'organizacao', nome: 'Atalhos ⚡ Mensagens prontas e 📋 Modelos do WhatsApp', oQueFaz: 'Botões na caixa de resposta para chamar as mensagens prontas e os modelos do WhatsApp sem sair da conversa.', estado: (e) => e.CHATWOOT_ATALHOS !== '0', variavel: 'CHATWOOT_ATALHOS' },
  { id: 'fixa-perdido-motivo', grupo: 'organizacao', nome: 'Botões «Perdido: motivo» (etiqueta vira etapa)', oQueFaz: 'A macro «Perdido: motivo» põe uma etiqueta e o servidor grava Etapa = Perdido e o motivo no cartão, tirando a etiqueta.', estado: null },
  { id: 'fixa-etiqueta-anuncio', grupo: 'rastreio', nome: 'Etiqueta «anuncio» na conversa que veio de anúncio', oQueFaz: 'Quando o anúncio «Clique para o WhatsApp» é comprovado, a conversa recebe a etiqueta «anuncio».', estado: (e) => e.CHATWOOT_ETIQUETA_ANUNCIO !== '0', variavel: 'CHATWOOT_ETIQUETA_ANUNCIO' },
  { id: 'fixa-nota-anuncio', grupo: 'rastreio', nome: 'Nota «Veio do anúncio»', oQueFaz: 'Nota privada com o título, o texto, os links e a imagem do anúncio de onde o paciente veio.', estado: (e) => e.CHATWOOT_NOTA_ANUNCIO !== '0', variavel: 'CHATWOOT_NOTA_ANUNCIO' },
  { id: 'fixa-avisos-regua', grupo: 'avisos', nome: 'Avisos internos da régua', oQueFaz: 'Lead quente parado, sem resposta e «Fechou» sem «Fechou tratamento» viram NOTA PRIVADA para a equipe (nunca mensagem ao paciente). Cada um liga e desliga na aba «Robôs de mensagem», em «Internas».', estado: null },
];

export interface UltimaAcao {
  em: string;
  nivel: string;
  texto: string;
  /** números do ciclo (conversas, gravadas…) quando o log traz */
  resumo: string;
}

export interface AutomacaoNaTela {
  id: string;
  grupo: GrupoDaAutomacao;
  grupoRotulo: string;
  nome: string;
  oQueFaz: string;
  cuidado: string | null;
  origem: 'catalogo' | 'fixa';
  /** o seletor de 3 estados só aparece nas do catálogo e só funciona para o administrador */
  editavel: boolean;
  /** 'sempre' = sem interruptor: roda sempre */
  estado: Estado | 'sempre';
  estados: Estado[];
  vemDoAmbiente: boolean;
  semVolta: boolean;
  exigeSecoAntes: boolean;
  risco: string | null;
  /** quem mexeu por último pela tela e quando; null = nunca mexeram (vale o padrão do servidor) */
  mudou: { por: string | null; em: string } | null;
  /** o que o log do servidor guardou (vazio com `semRegistro` = não achei nada) */
  ultimas: UltimaAcao[];
  semRegistro: boolean;
  nota: string | null;
}

export interface BancoDasAutomacoes {
  /** quem mexeu e quando, por automação, desta unidade */
  mudancas(slug: string, ids: string[]): Promise<Array<{ automacao: string; por: string | null; em: Date }>>;
  /** as últimas linhas do log do servidor que começam com `<id>:` e são desta unidade */
  ultimas(id: string, slug: string, quantas: number): Promise<UltimaAcao[]>;
  unidade(slug: string): Promise<{ id: string; slug: string } | null>;
  gravar(unit: { id: string }, automacao: string, estado: Estado, por: string): Promise<void>;
}

const NOTA_FIXA = 'Controlado pela Doutor Digital: não tem chave por unidade nesta tela.';

/**
 * O histórico de cada automação sai de system_logs, que só tem índice por data: para uma automação que quase não
 * escreve log, a busca varria a tabela inteira (≈9 s cada, ≈60 s a aba «Automações», 15/11/2026). Agora as buscas
 * correm juntas, olham só os últimos dias e têm teto: estourou, a automação aparece sem as últimas ações.
 */
export const DIAS_DO_HISTORICO = 14;
export const TETO_DO_HISTORICO_MS = 3000;
export function comTeto<T>(p: Promise<T>, ms: number, padrao: T, o: { propagarErro?: boolean } = {}): Promise<T> {
  return new Promise((ok, falha) => {
    const t = setTimeout(() => ok(padrao), ms);
    p.then(
      (v) => { clearTimeout(t); ok(v); },
      // padrão: erro vira o `padrao` (a tela abre sem a parte). Com `propagarErro`, só o TETO ESTOURADO vira `padrao`; erro de verdade (401, 5xx) passa adiante.
      (e) => { clearTimeout(t); if (o.propagarErro) falha(e); else ok(padrao); },
    );
  });
}

export async function automacoesDaUnidade(
  banco: BancoDasAutomacoes,
  slug: string,
  o: { env?: NodeJS.ProcessEnv; panorama?: ReturnType<typeof panoramaDaUnidade>; tetoMs?: number } = {},
): Promise<AutomacaoNaTela[]> {
  const env = o.env ?? process.env;
  const panorama = o.panorama ?? panoramaDaUnidade(slug, env);
  const ids = Object.keys(DO_CATALOGO);
  const ultimasDe = new Map(
    await Promise.all(ids.map(async (id) => [id, await comTeto(banco.ultimas(id, slug, 5), o.tetoMs ?? TETO_DO_HISTORICO_MS, [] as UltimaAcao[])] as const)),
  );
  const mudancas = new Map((await banco.mudancas(slug, ids)).map((m) => [m.automacao, m]));
  const saida: AutomacaoNaTela[] = [];
  for (const id of ids) {
    const a = automacaoPorId(id);
    const linha = panorama.find((p) => p.id === id);
    if (!a || !linha) continue;
    const ultimas = ultimasDe.get(id) ?? [];
    const m = mudancas.get(id);
    saida.push({
      id,
      grupo: DO_CATALOGO[id]!,
      grupoRotulo: ROTULO_DO_GRUPO_AUTO[DO_CATALOGO[id]!],
      nome: a.nome,
      oQueFaz: a.oQueFaz,
      cuidado: a.pegadinha ?? null,
      origem: 'catalogo',
      editavel: true,
      estado: linha.estado,
      estados: a.temSeco ? ['ligado', 'seco', 'desligado'] : ['ligado', 'desligado'],
      vemDoAmbiente: linha.vemDoAmbiente,
      semVolta: semVolta(a),
      exigeSecoAntes: !!a.exigeSecoAntes,
      risco: a.risco,
      // o dado gravado fica «(Chatwoot)» (a trilha de auditoria tem um formato só); a tela mostra «(CRM)», para as linhas antigas e as novas
      mudou: m ? { por: m.por === null ? null : m.por.replace(/\(Chatwoot\)$/, '(CRM)'), em: m.em.toISOString() } : null,
      ultimas,
      semRegistro: ultimas.length === 0,
      nota: null,
    });
  }
  for (const f of FIXAS) {
    saida.push({
      id: f.id,
      grupo: f.grupo,
      grupoRotulo: ROTULO_DO_GRUPO_AUTO[f.grupo],
      nome: f.nome,
      oQueFaz: f.oQueFaz,
      cuidado: null,
      origem: 'fixa',
      editavel: false,
      estado: f.estado ? (f.estado(env) ? 'ligado' : 'desligado') : 'sempre',
      estados: [],
      vemDoAmbiente: true,
      semVolta: false,
      exigeSecoAntes: false,
      risco: null,
      mudou: null,
      ultimas: [],
      semRegistro: true,
      nota: NOTA_FIXA,
    });
  }
  const ordem = (g: GrupoDaAutomacao) => ORDEM_DOS_GRUPOS.indexOf(g);
  return saida.sort((a, b) => ordem(a.grupo) - ordem(b.grupo));
}

// ── mudar o estado ────────────────────────────────────────────────────────────────────────────────

export type ResultadoDaAutomacao = { ok: true; id: string; estado: Estado } | { ok: false; status: 400 | 403 | 404 | 409; erro: string; precisaConfirmar?: boolean };

/** Só o administrador do Chatwoot (da unidade, já conferido pela rota) muda; atendente só vê. Mesmas regras do console + confirmação do que não tem volta. */
export async function mudarAutomacao(
  banco: BancoDasAutomacoes,
  p: { slug: string; id: unknown; estado: unknown; confirmar?: unknown; papel: string | null | undefined; por: string; estadoAtual: (id: string) => Estado | null },
): Promise<ResultadoDaAutomacao> {
  if (!podeMexerNosRobos(p.papel)) return { ok: false, status: 403, erro: 'só quem administra o CRM muda as automações — peça para a Suzanne ou para o João' };
  const id = typeof p.id === 'string' ? p.id : '';
  const a = id in DO_CATALOGO ? automacaoPorId(id) : undefined;
  if (!a) return { ok: false, status: 404, erro: 'automação não encontrada' };
  if (!ehEstado(p.estado)) return { ok: false, status: 400, erro: 'estado precisa ser "ligado", "seco" ou "desligado"' };
  if (p.estado === 'seco' && !a.temSeco) return { ok: false, status: 400, erro: `"${a.nome}" não tem modo seco` };
  const hoje = p.estadoAtual(id);
  if (p.estado === 'ligado' && a.exigeSecoAntes && hoje !== 'seco' && hoje !== 'ligado') {
    return { ok: false, status: 400, erro: `"${a.nome}" só liga depois de rodar em "Só no papel": ponha em "Só no papel", espere uma rodada e confira o log antes` };
  }
  if (p.estado === 'ligado' && hoje !== 'ligado' && semVolta(a) && p.confirmar !== true) {
    return { ok: false, status: 409, precisaConfirmar: true, erro: `"${a.nome}" NÃO TEM VOLTA: o que ela faz não se desfaz. Confirme para ligar.` };
  }
  const unit = await banco.unidade(p.slug);
  if (!unit) return { ok: false, status: 404, erro: 'unidade não encontrada' };
  await banco.gravar(unit, id, p.estado, `${p.por.slice(0, 70) || 'administrador'} (Chatwoot)`);
  return { ok: true, id, estado: p.estado };
}

// ── o banco de verdade ───────────────────────────────────────────────────────────────────────────

/** Resume os números do contexto de um log de ciclo («conversas 12 · gravadas 3»). */
export function resumoDoContexto(ctx: unknown): string {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return '';
  return Object.entries(ctx as Record<string, unknown>)
    .filter(([k, v]) => typeof v === 'number' && !['pid', 'caixa', 'time', 'v'].includes(k))
    .slice(0, 6)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}

export function bancoDasAutomacoes(): BancoDasAutomacoes {
  return {
    async mudancas(slug, ids) {
      const l = await prisma.unitAutomacao.findMany({ where: { automacao: { in: ids }, unit: { slug } }, select: { automacao: true, atualizadoPor: true, atualizadoEm: true } });
      return l.map((x) => ({ automacao: x.automacao, por: x.atualizadoPor, em: x.atualizadoEm }));
    },
    async ultimas(id, slug, quantas) {
      const l = await prisma.systemLog.findMany({
        where: { createdAt: { gte: new Date(Date.now() - DIAS_DO_HISTORICO * 86_400_000) }, msg: { startsWith: `${id}:` }, context: { path: ['slug'], equals: slug } },
        orderBy: { createdAt: 'desc' },
        take: quantas,
        select: { createdAt: true, level: true, msg: true, context: true },
      });
      return l.map((x) => ({ em: x.createdAt.toISOString(), nivel: String(x.level), texto: x.msg.slice(0, 200), resumo: resumoDoContexto(x.context) }));
    },
    async unidade(slug) {
      return prisma.unit.findUnique({ where: { slug }, select: { id: true, slug: true } });
    },
    gravar: (unit, automacao, estado, por) => gravarEstadoDaAutomacao(unit, automacao, estado, por),
  };
}

