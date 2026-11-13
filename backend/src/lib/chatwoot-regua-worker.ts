/**
 * O worker da RÉGUA no Chatwoot (`chatwoot-regua`): a cada 10 min lê as conversas da caixa de cada unidade que estiver
 * em «seco» ou «ligado» e aplica `decidirRegua` (chatwoot-regua.ts, onde estão as regras e as explicações).
 *
 *  - SECO: em vez de mandar ao paciente, deixa uma NOTA PRIVADA na conversa («🧪 [SECO] Régua … — enviaria agora: …») e registra no banco.
 *  - LIGADO: manda a mensagem pública. Implementado, mas ninguém liga agora. Regra INTERNA (quente parado, sem resposta 24 h,
 *    pendência de «Fechou») nunca vira mensagem: nota privada + a ação (prioridade, etiqueta, etapa).
 *  - Reaproveita o cliente do Chatwoot do conector (`mcp-remoto/chatwoot.ts`, env CHATWOOT_API_TOKEN / CHATWOOT_CONTA_ID / CHATWOOT_URL): sem env novo.
 *    Sem token, o worker nem sobe.
 *  - Nunca repete: a linha de `chatwoot_regua_disparo` é GRAVADA ANTES de agir (UNIQUE conversa+regra+chave); duas cópias do servidor
 *    não mandam em dobro. Seco que falha ao deixar a nota desfaz a linha (tenta no próximo ciclo). Ligado com resposta de erro do
 *    Chatwoot (4xx) também desfaz; erro sem resposta (tempo esgotado: pode ter ido) NÃO desfaz — melhor uma mensagem a menos que duas.
 *  - Tetos por ciclo (mensagens e etiquetas): se um defeito soltar tudo de uma vez, vaza só um pouco por ciclo.
 *  - Sinal interno (sempre ao vivo quando a régua não está desligada): etiqueta `respondeu-pelo-celular`.
 *  - Caixa de WhatsApp Cloud (CAIXAS_CLOUD): a Meta só aceita texto livre com a janela de 24 h aberta (a última mensagem RECEBIDA do
 *    paciente, com folga de 15 min). Janela fechada → manda o TEMPLATE de mesmo nome do modelo (`parau_*`, criado na Meta com os
 *    mesmos campos na ordem {{1}}, {{2}}…) se ele estiver aprovado na lista da caixa; não aprovado → nota privada, uma vez por chave
 *    (regra `<regra>!template`), e o envio continua possível nos ciclos seguintes. Caixa 2 (Evolution) não tem janela: só texto.
 *  - Sem dobrar com o Kommo (decisão do João, 12/11/2026, item 31): antes de falar com o PACIENTE, confere pelo telefone se ele tem
 *    cartão ATIVO (nem ganho nem perdido) no Kommo da unidade — lá os robôs do Kommo já mandam. Tem: não manda, só deixa nota
 *    (e registra, para não tentar de novo). Não deu para consultar o Kommo: ligado NÃO manda e tenta no próximo ciclo.
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { precosDaConsulta } from '../agent/prompt-composer.js';
import { enviarPelaEvolution } from './alerta-whatsapp.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import {
  atualizarVistos,
  CAIXAS_CLOUD,
  CAIXAS_REGUA,
  CAMPO_PARTIDA,
  GERENTE_DA_CAIXA,
  conversaDoChatwoot,
  decidirEtiquetaCelular,
  decidirRegua,
  ETIQUETA_CELULAR,
  IDIOMA_TEMPLATE,
  janelaDe24hAberta,
  precisaUltimaPublica,
  resumoDaMensagem,
  type AcaoInterna,
  type MensagemResumo,
  type ViaDoEnvio,
  ID_REGUA,
  notaDoSeco,
  SUFIXO_FALTA,
  type ConversaRegua,
  type DadosDaUnidade,
  type Mudanca,
  type Visto,
} from './chatwoot-regua.js';

const SWEEP_MS = Number(process.env.CHATWOOT_REGUA_SWEEP_MS) || 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 150_000;
/** 25 conversas por página. */
const MAX_PAGINAS = 200;
export const MAX_MENSAGENS_POR_CICLO = 60;
export const MAX_ETIQUETAS_POR_CICLO = 100;
/** Sufixo da regra quando o que se registra é «template ainda não aprovado» (a nota sai uma vez por chave; o envio continua possível). */
export const SUFIXO_SEM_TEMPLATE = '!template';
/** Quanto do histórico de disparos o ciclo carrega para conferir repetição (a UNIQUE do banco vale para sempre). */
const DIAS_DE_FEITOS = 130;
const PAUSA_ENTRE_ESCRITAS_MS = 120;

// ── portas (trocáveis no teste) ────────────────────────────────────────────────────────────────────

export interface LinhaVista {
  conversationId: number;
  campo: string;
  valor: string;
  desde: Date;
  inicial: boolean;
}

export interface Armazem {
  vistos(caixa: number): Promise<LinhaVista[]>;
  salvar(caixa: number, mudancas: Array<Mudanca & { conversationId: number }>): Promise<void>;
  feitos(caixa: number, desde: Date): Promise<Array<{ conversationId: number; regra: string; chave: string }>>;
  /** false = já existia (outra cópia do servidor ou ciclo anterior) */
  registrar(l: { caixa: number; conversationId: number; regra: string; chave: string; modo: string; texto: string }): Promise<boolean>;
  desfazer(conversationId: number, regra: string, chave: string): Promise<void>;
}

/** Template da Meta a mandar no lugar do texto livre (caixa de WhatsApp Cloud com a janela de 24 h fechada). */
export interface EnvioTemplate {
  nome: string;
  idioma: string;
  /** valores de {{1}}, {{2}}… na ordem */
  variaveis: string[];
}

export interface Chat {
  /** uma página (25) da listagem da caixa; vazia = acabou */
  pagina(caixa: number, pagina: number): Promise<unknown[]>;
  /** Com `template`, vai o template (o `texto` é o que aparece na conversa); sem ele, texto livre. */
  mensagem(conversationId: number, texto: string, privada: boolean, template?: EnvioTemplate): Promise<void>;
  /** Quando o PACIENTE escreveu por último nesta conversa (mensagem recebida); null = nunca. Conta a janela de 24 h. */
  ultimaDoPaciente(conversationId: number): Promise<Date | null>;
  /** Os nomes dos templates APROVADOS (no idioma da régua) que o Chatwoot guarda na caixa. Lança se não deu para ler. */
  templatesAprovados(caixa: number): Promise<ReadonlySet<string>>;
  etiquetas(conversationId: number, etiquetas: string[]): Promise<void>;
  /** grava os atributos da conversa (o Chatwoot SUBSTITUI o objeto inteiro: mandar todos) */
  atributos(conversationId: number, attrs: Record<string, unknown>): Promise<void>;
  prioridade(conversationId: number, prioridade: 'urgent' | 'high' | 'medium' | 'low'): Promise<void>;
  /** atribui a conversa a um agente (o app do Chatwoot avisa a pessoa) */
  atribuir(conversationId: number, agente: number): Promise<void>;
  /** a última mensagem pública (não nota) da conversa; null = nenhuma */
  ultimaPublica(conversationId: number): Promise<MensagemResumo | null>;
}

/** Cartão ativo no Kommo da unidade para este telefone (null = nenhum). Lança se não deu para consultar. */
export type CartaoNoKommo = (telefone: string) => Promise<{ leadId: number } | null>;

export interface DepsDoCiclo {
  armazem: Armazem;
  chat: Chat;
  pausa: (ms: number) => Promise<void>;
  /** sem ela, a régua não confere o Kommo (unidade sem Kommo) */
  kommo?: CartaoNoKommo;
  /** aviso no WhatsApp da gerente (lead quente parado); sem ela, só a atribuição no Chatwoot */
  avisarGerente?: (texto: string, chave: string) => Promise<unknown>;
}

/**
 * WhatsApp da gerente por unidade: `CHATWOOT_GERENTE_WHATSAPP="slug=5594…,slug2=55…"`, mandado pela instância dos alertas
 * (EVOLUTION_ALERT_URL/HEADER/VALUE, a mesma do aviso ao João). Sem env: null (só a atribuição no Chatwoot).
 */
export function numeroDaGerente(slug: string, env: string | undefined = process.env.CHATWOOT_GERENTE_WHATSAPP): string | null {
  for (const par of String(env ?? '').split(',')) {
    const [s, n] = par.split('=').map((x) => x?.trim() ?? '');
    if (s === slug && /^\d{10,15}$/.test(n ?? '')) return n!;
  }
  return null;
}

export function avisoDaGerente(slug: string): DepsDoCiclo['avisarGerente'] {
  const numero = numeroDaGerente(slug);
  const { EVOLUTION_ALERT_URL: url, EVOLUTION_ALERT_HEADER: header, EVOLUTION_ALERT_VALUE: valor } = process.env;
  if (!numero || !url || !header || !valor) return undefined;
  return (texto) => enviarPelaEvolution({ url, header, valor, numero, texto });
}

/** status do Kommo que fecham o cartão: 142 = ganho, 143 = perdido */
const FECHADOS_NO_KOMMO = new Set([142, 143]);

/** Os 8 últimos dígitos: casa com e sem o 9 e com e sem o +55. */
export function finalDoTelefone(telefone: string | undefined): string | null {
  const d = String(telefone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

export function cartaoNoKommoDaUnidade(unit: Parameters<typeof createKommoClientSemFreio>[0]): CartaoNoKommo {
  const kommo = createKommoClientSemFreio(unit);
  return async (telefone) => {
    const fim = finalDoTelefone(telefone);
    if (!fim) return null;
    const contatos = await kommo.buscarContatosPorTelefone(fim, 10);
    const leads = contatos
      .filter((c) => c.telefones.some((t) => finalDoTelefone(t) === fim))
      .flatMap((c) => c.leadIds)
      .slice(0, 8);
    for (const id of leads) {
      const lead = await kommo.getLead(id);
      if (lead && !FECHADOS_NO_KOMMO.has(Number(lead.status_id))) return { leadId: id };
    }
    return null;
  };
}

export function armazemDoBanco(): Armazem {
  return {
    async vistos(caixa) {
      return prisma.chatwootReguaVisto.findMany({ where: { caixa }, select: { conversationId: true, campo: true, valor: true, desde: true, inicial: true } });
    },
    async salvar(caixa, mudancas) {
      const criar = mudancas.filter((m): m is Extract<Mudanca, { tipo: 'criar' }> & { conversationId: number } => m.tipo === 'criar');
      for (let i = 0; i < criar.length; i += 500) {
        await prisma.chatwootReguaVisto.createMany({
          data: criar.slice(i, i + 500).map((m) => ({ caixa, conversationId: m.conversationId, campo: m.campo, valor: m.valor, desde: m.desde, inicial: m.inicial })),
          skipDuplicates: true,
        });
      }
      const resto = mudancas.filter((m) => m.tipo !== 'criar');
      for (let i = 0; i < resto.length; i += 100) {
        await prisma.$transaction(
          resto.slice(i, i + 100).map((m) =>
            m.tipo === 'atualizar'
              ? prisma.chatwootReguaVisto.updateMany({ where: { caixa, conversationId: m.conversationId, campo: m.campo }, data: { valor: m.valor, desde: m.desde, inicial: false } })
              : prisma.chatwootReguaVisto.deleteMany({ where: { caixa, conversationId: m.conversationId, campo: m.campo } }),
          ),
        );
      }
    },
    async feitos(caixa, desde) {
      return prisma.chatwootReguaDisparo.findMany({ where: { caixa, criadoEm: { gte: desde } }, select: { conversationId: true, regra: true, chave: true } });
    },
    async registrar(l) {
      try {
        await prisma.chatwootReguaDisparo.create({ data: l });
        return true;
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') return false;
        throw err;
      }
    },
    async desfazer(conversationId, regra, chave) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { conversationId, regra, chave } });
    },
  };
}

/** Quantas páginas (20 mensagens) de histórico a busca da última mensagem do paciente percorre antes de dizer «nunca escreveu». */
const PAGINAS_PARA_ACHAR_O_PACIENTE = 5;

/**
 * O `template_params` que o Chatwoot 4.19.1 aceita em POST conversations/:id/messages (Whatsapp::TemplateProcessorService):
 * `name` + `language` + `processed_params: { body: { "1": "…", "2": "…" } }`. `content_mode: 'rendered'` impede o Chatwoot de passar os
 * valores pelo Liquid. O modelo só sai se estiver `approved` e no mesmo idioma na lista de templates da caixa.
 */
export function paramsDoTemplate(t: EnvioTemplate): Record<string, unknown> {
  const body = Object.fromEntries(t.variaveis.map((v, i) => [String(i + 1), v]));
  return { name: t.nome, language: t.idioma, content_mode: 'rendered', ...(t.variaveis.length ? { processed_params: { body } } : {}) };
}

export function chatDoChatwoot(ctx: ContextoChatwoot): Chat {
  return {
    async pagina(caixa, pagina) {
      const r = (await chamar(ctx, 'GET', 'conversations', {
        query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) },
      })) as { data?: { payload?: unknown[] }; payload?: unknown[] } | null;
      const lista = r?.data?.payload ?? r?.payload ?? [];
      return Array.isArray(lista) ? lista : [];
    },
    async mensagem(conversationId, texto, privada, template) {
      await chamar(ctx, 'POST', `conversations/${conversationId}/messages`, {
        corpo: { content: texto, message_type: 'outgoing', private: privada, ...(template ? { template_params: paramsDoTemplate(template) } : {}) },
      });
    },
    async ultimaDoPaciente(conversationId) {
      // o Chatwoot devolve as 20 mais novas em ordem crescente; `before=<id>` traz as 20 anteriores
      let antes: number | undefined;
      for (let i = 0; i < PAGINAS_PARA_ACHAR_O_PACIENTE; i++) {
        const r = (await chamar(ctx, 'GET', `conversations/${conversationId}/messages`, { query: antes ? { before: String(antes) } : {} })) as { payload?: unknown[] } | null;
        const lista = Array.isArray(r?.payload) ? (r.payload as Array<{ id?: number; message_type?: number; created_at?: number }>) : [];
        if (lista.length === 0) return null;
        for (let j = lista.length - 1; j >= 0; j--) {
          const m = lista[j]!;
          if (Number(m.message_type) === 0 && Number(m.created_at) > 0) return new Date(Number(m.created_at) * 1000);
        }
        const primeiro = Number(lista[0]?.id);
        if (!Number.isInteger(primeiro) || primeiro <= 0) return null;
        antes = primeiro;
      }
      return null;
    },
    async templatesAprovados(caixa) {
      const r = (await chamar(ctx, 'GET', `inboxes/${caixa}/message_templates`)) as { payload?: unknown[] } | null;
      const lista = Array.isArray(r?.payload) ? (r.payload as Array<{ name?: string; language?: string; status?: string }>) : [];
      return new Set(
        lista
          .filter((t) => String(t?.status ?? '').toUpperCase() === 'APPROVED' && String(t?.language ?? '').toLowerCase() === IDIOMA_TEMPLATE.toLowerCase())
          .map((t) => String(t.name)),
      );
    },
    async etiquetas(conversationId, etiquetas) {
      // o Chatwoot SUBSTITUI a lista inteira: quem chama manda a lista completa
      await chamar(ctx, 'POST', `conversations/${conversationId}/labels`, { corpo: { labels: etiquetas } });
    },
    async atributos(conversationId, attrs) {
      await chamar(ctx, 'POST', `conversations/${conversationId}/custom_attributes`, { corpo: { custom_attributes: attrs } });
    },
    async atribuir(conversationId, agente) {
      await chamar(ctx, 'POST', `conversations/${conversationId}/assignments`, { corpo: { assignee_id: agente } });
    },
    async prioridade(conversationId, prioridade) {
      await chamar(ctx, 'POST', `conversations/${conversationId}/toggle_priority`, { corpo: { priority: prioridade } });
    },
    async ultimaPublica(conversationId) {
      const r = (await chamar(ctx, 'GET', `conversations/${conversationId}/messages`)) as { payload?: unknown[] } | null;
      const lista = Array.isArray(r?.payload) ? r.payload : [];
      for (let i = lista.length - 1; i >= 0; i--) {
        const m = resumoDaMensagem(lista[i]);
        if (m && !m.privada) return m;
      }
      return null;
    },
  };
}

// ── o ciclo ────────────────────────────────────────────────────────────────────────────────────────

export interface ResumoDoCiclo {
  conversas: number;
  truncada: boolean;
  disparos: number;
  faltando: number;
  perdidas: Record<string, number>;
  etiquetas: number;
  falhas: number;
  primeiraVez: boolean;
  /** mensagens ao paciente seguradas porque ele tem cartão ativo no Kommo (vira nota) */
  noKommo: number;
  /** das `disparos`, quantas foram pelo template (janela de 24 h fechada) */
  comTemplate: number;
  /** seguradas porque o template ainda não está aprovado na Meta (vira nota) */
  semTemplate: number;
}

async function lerConversas(chat: Chat, caixa: number): Promise<{ conversas: ConversaRegua[]; truncada: boolean }> {
  const vistas = new Set<number>();
  const conversas: ConversaRegua[] = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const pagina = await chat.pagina(caixa, p);
    if (pagina.length === 0) return { conversas, truncada: false };
    for (const raw of pagina) {
      const c = conversaDoChatwoot(raw);
      if (!c || vistas.has(c.id)) continue;
      vistas.add(c.id);
      conversas.push(c);
    }
  }
  return { conversas, truncada: true };
}

/**
 * Ligado: a ação da regra interna (o robô do Kommo fazia o mesmo). Mexe na cópia local da conversa para a etiqueta do celular,
 * mais adiante no mesmo ciclo, não desfazer o que foi posto aqui.
 */
export async function executarInterna(
  chat: Chat,
  c: ConversaRegua,
  acao: AcaoInterna,
  extra: { gerente?: number; avisarGerente?: DepsDoCiclo['avisarGerente']; unidade?: string } = {},
): Promise<void> {
  if (acao === 'quente-parado') {
    await chat.prioridade(c.id, 'urgent');
    // decisão 26: vai para a gerente (o app avisa) e, se configurado, aviso no WhatsApp dela
    if (extra.gerente) await chat.atribuir(c.id, extra.gerente);
    if (extra.avisarGerente) {
      const quem = c.nome || c.telefone || `conversa ${c.id}`;
      await extra.avisarGerente(`🔥 Lead QUENTE parado há 3 h${extra.unidade ? ` (${extra.unidade})` : ''}: ${quem}. Abra a conversa ${c.id} no Chatwoot.`, `quente-${c.id}`);
    }
    return;
  }
  const etiqueta = acao === 'sem-resposta' ? 'sem-resposta' : 'pendente-de-revisao';
  if (!c.etiquetas.includes(etiqueta)) {
    c.etiquetas = [...c.etiquetas, etiqueta];
    await chat.etiquetas(c.id, c.etiquetas);
  }
  if (acao === 'sem-resposta') {
    c.attrs = { ...c.attrs, motivo_nao_agendamento: 'Não interagiu', etapa: 'Perdido' };
    await chat.atributos(c.id, c.attrs);
  }
}

const statusDoErro = (e: unknown): number | undefined => (e as { status?: number })?.status;

/**
 * Um ciclo de uma caixa. `modo` nunca é «desligado» aqui. Não lança por causa de UMA conversa: a falha dela vira log e conta em `falhas`.
 * Falha ao LISTAR as conversas aborta o ciclo (a memória não é tocada).
 */
export async function cicloDaCaixa(deps: DepsDoCiclo, caixa: number, slug: string, modo: 'seco' | 'ligado', unidade: DadosDaUnidade, agora: Date): Promise<ResumoDoCiclo> {
  const { armazem, chat } = deps;
  const { conversas, truncada } = await lerConversas(chat, caixa);

  // memória: o que já foi visto e o que já foi decidido
  const linhas = await armazem.vistos(caixa);
  const partidaLinha = linhas.find((l) => l.conversationId === 0 && l.campo === CAMPO_PARTIDA);
  const primeiraVez = !partidaLinha;
  const partida = { primeiraVez, desde: partidaLinha?.desde ?? agora };
  const porConversa = new Map<number, Map<string, Visto>>();
  for (const l of linhas) {
    if (l.conversationId === 0) continue;
    const m = porConversa.get(l.conversationId) ?? new Map<string, Visto>();
    m.set(l.campo, { valor: l.valor, desde: l.desde, inicial: l.inicial });
    porConversa.set(l.conversationId, m);
  }
  const feitosLinhas = await armazem.feitos(caixa, new Date(agora.getTime() - DIAS_DE_FEITOS * 86_400_000));
  const feitosPorConversa = new Map<number, Set<string>>();
  for (const f of feitosLinhas) {
    const s = feitosPorConversa.get(f.conversationId) ?? new Set<string>();
    s.add(`${f.regra}|${f.chave}`);
    feitosPorConversa.set(f.conversationId, s);
  }

  const resumo: ResumoDoCiclo = { conversas: conversas.length, truncada, disparos: 0, faltando: 0, perdidas: {}, etiquetas: 0, falhas: 0, primeiraVez, noKommo: 0, comTemplate: 0, semTemplate: 0 };
  const mudancas: Array<Mudanca & { conversationId: number }> = [];
  if (primeiraVez) mudancas.push({ conversationId: 0, tipo: 'criar', campo: CAMPO_PARTIDA, valor: '1', desde: agora, inicial: true });
  const pendentes: Array<{ c: ConversaRegua; vistos: ReadonlyMap<string, Visto> }> = [];
  for (const c of conversas) {
    const r = atualizarVistos(c, porConversa.get(c.id) ?? new Map(), agora, partida);
    for (const m of r.mudancas) mudancas.push({ ...m, conversationId: c.id });
    pendentes.push({ c, vistos: r.vistos });
  }
  // a memória primeiro: se o ciclo falhar depois, o "desde" já está guardado
  await armazem.salvar(caixa, mudancas);

  let mensagens = 0;
  let etiquetas = 0;
  // uma consulta ao Kommo por conversa por ciclo (só das que vão falar com o paciente)
  const noKommo = new Map<number, Promise<{ leadId: number } | null>>();
  const cartaoAtivo = (c: ConversaRegua) => {
    if (!deps.kommo || !c.telefone) return Promise.resolve(null);
    let p = noKommo.get(c.id);
    if (!p) {
      p = deps.kommo(c.telefone);
      noKommo.set(c.id, p);
    }
    return p;
  };
  // caixa de WhatsApp Cloud: janela de 24 h e templates (uma leitura da lista de templates por ciclo, só se precisar)
  const cloud = CAIXAS_CLOUD.has(caixa);
  let aprovadosDoCiclo: Promise<ReadonlySet<string>> | null = null;
  const aprovados = () => (aprovadosDoCiclo ??= deps.chat.templatesAprovados(caixa));
  /** Quando o paciente escreveu por último: a própria última mensagem da listagem, se for dele; senão o histórico. */
  const ultimaDoPaciente = async (c: ConversaRegua): Promise<Date | null> =>
    c.ultima && !c.ultima.saida && !c.ultima.privada ? c.ultima.criadaEm : deps.chat.ultimaDoPaciente(c.id);
  for (const { c, vistos } of pendentes) {
    try {
      if (precisaUltimaPublica(c)) c.ultima = await chat.ultimaPublica(c.id);
      const feitosDaConversa = feitosPorConversa.get(c.id) ?? new Set<string>();
      const { disparos, perdidas } = decidirRegua(c, { vistos, feitos: feitosDaConversa }, agora, unidade);
      for (const r of perdidas) resumo.perdidas[r] = (resumo.perdidas[r] ?? 0) + 1;
      for (const d of disparos) {
        if (mensagens >= MAX_MENSAGENS_POR_CICLO) break;
        const faltou = d.texto === null;
        let regra = faltou ? `${d.regra}${SUFIXO_FALTA}` : d.regra;
        // faltou campo: só o seco avisa (uma vez por chave); ligado não manda nem anota
        if (faltou && modo === 'ligado') continue;
        let nota = notaDoSeco(d);
        let avisos = '';
        // regra interna nunca fala com o paciente: no ligado também é nota privada (mais a ação)
        let privada = modo === 'seco' || !!d.interna;
        let texto = modo === 'seco' ? nota : d.interna ? `🤖 Régua «${d.regra}»: ${d.texto}` : (d.texto as string);
        let seguradaNoKommo = false;
        let semTemplate = false;
        let template: EnvioTemplate | undefined;
        // falaria com o paciente: cartão ativo no Kommo da unidade → não manda (os robôs de lá já falam), só nota
        if (!faltou && !d.interna) {
          let cartao: { leadId: number } | null;
          try {
            cartao = await cartaoAtivo(c);
          } catch (err) {
            logger.warn({ err: String(err), caixa, conversa: c.id, regra: d.regra }, `${ID_REGUA}: não consegui conferir o Kommo — não mando agora`);
            if (modo === 'ligado') continue;
            cartao = null;
            avisos += '\n\n⚠️ Não consegui conferir o Kommo agora (no ligado, esperaria o próximo ciclo).';
            nota += avisos;
            texto = nota;
          }
          if (cartao) {
            nota = `${modo === 'seco' ? '🧪 [SECO] ' : '🛑 '}Régua «${d.regra}» — NÃO ${modo === 'seco' ? 'enviaria' : 'enviei'}: o paciente tem cartão ativo no Kommo da unidade (lead ${cartao.leadId}); os robôs de lá cuidam.`;
            texto = nota;
            privada = true;
            seguradaNoKommo = true;
          }
        }
        // caixa de WhatsApp Cloud: janela de 24 h aberta → texto; fechada → template aprovado (a Meta recusa texto livre)
        if (cloud && !faltou && !d.interna && !seguradaNoKommo && d.variaveis) {
          let via: ViaDoEnvio | undefined;
          try {
            if (janelaDe24hAberta(await ultimaDoPaciente(c), agora)) {
              via = { tipo: 'texto' };
            } else {
              via = { tipo: 'template', nome: d.modelo, variaveis: d.variaveis, aprovado: (await aprovados()).has(d.modelo) };
            }
          } catch (err) {
            logger.warn({ err: String(err), caixa, conversa: c.id, regra: d.regra }, `${ID_REGUA}: não consegui conferir a janela de 24 h/os templates — não mando agora`);
            if (modo === 'ligado') continue;
            avisos += '\n\n⚠️ Não consegui conferir a janela de 24 h/os templates agora (no ligado, esperaria o próximo ciclo).';
            nota = notaDoSeco(d) + avisos;
            texto = nota;
          }
          if (via && modo === 'seco') {
            nota = notaDoSeco(d, via) + avisos;
            texto = nota;
          } else if (via?.tipo === 'template') {
            if (via.aprovado) {
              template = { nome: via.nome, idioma: IDIOMA_TEMPLATE, variaveis: via.variaveis };
            } else {
              // sem template aprovado não há o que mandar: uma nota por chave (o envio segue possível nos próximos ciclos, quando aprovar)
              regra = `${d.regra}${SUFIXO_SEM_TEMPLATE}`;
              if (feitosDaConversa.has(`${regra}|${d.chave}`)) continue;
              semTemplate = true;
              privada = true;
              texto = `🤖 Régua «${d.regra}»: template ${d.modelo} ainda não aprovado na Meta — não enviei`;
            }
          }
        }
        const novo = await armazem.registrar({ caixa, conversationId: c.id, regra, chave: d.chave, modo, texto: template ? `[template ${template.nome}] ${texto}` : texto });
        if (!novo) continue;
        mensagens++;
        try {
          await deps.chat.mensagem(c.id, texto, privada, template);
          if (faltou) resumo.faltando++;
          else if (seguradaNoKommo) resumo.noKommo++;
          else if (semTemplate) resumo.semTemplate++;
          else {
            resumo.disparos++;
            if (template) resumo.comTemplate++;
          }
          await deps.pausa(PAUSA_ENTRE_ESCRITAS_MS);
        } catch (err) {
          resumo.falhas++;
          const status = statusDoErro(err);
          // seco e nota: tenta de novo no próximo ciclo. Ligado: só desfaz se o Chatwoot RECUSOU (4xx); sem resposta pode ter ido.
          if (modo === 'seco' || semTemplate || (status !== undefined && status >= 400 && status < 500)) await armazem.desfazer(c.id, regra, d.chave).catch(() => undefined);
          logger.warn({ err: String(err), caixa, conversa: c.id, regra: d.regra, modo, template: template?.nome }, `${ID_REGUA}: não consegui ${privada ? 'deixar a nota' : 'mandar a mensagem'}`);
          continue;
        }
        if (modo === 'ligado' && d.interna) {
          try {
            await executarInterna(deps.chat, c, d.interna, { gerente: GERENTE_DA_CAIXA[caixa], avisarGerente: deps.avisarGerente, unidade: unidade.nome });
          } catch (err) {
            resumo.falhas++;
            logger.warn({ err: String(err), caixa, conversa: c.id, regra: d.regra }, `${ID_REGUA}: nota deixada, mas a ação interna falhou`);
          }
        }
      }
      // sinal interno: não é mensagem ao paciente
      const et = etiquetas < MAX_ETIQUETAS_POR_CICLO ? decidirEtiquetaCelular(c) : null;
      if (et) {
        const lista = et === 'por' ? [...c.etiquetas, ETIQUETA_CELULAR] : c.etiquetas.filter((x) => x !== ETIQUETA_CELULAR);
        etiquetas++;
        try {
          await deps.chat.etiquetas(c.id, lista);
          resumo.etiquetas++;
          await deps.pausa(PAUSA_ENTRE_ESCRITAS_MS);
        } catch (err) {
          resumo.falhas++;
          logger.warn({ err: String(err), caixa, conversa: c.id }, `${ID_REGUA}: não consegui mexer na etiqueta ${ETIQUETA_CELULAR}`);
        }
      }
    } catch (err) {
      resumo.falhas++;
      logger.warn({ err: String(err), caixa, conversa: c.id }, `${ID_REGUA}: falhou numa conversa — sigo com as outras`);
    }
  }
  logger.info({ slug, caixa, modo, ...resumo }, `${ID_REGUA}: ciclo`);
  return resumo;
}

// ── liga/desliga ───────────────────────────────────────────────────────────────────────────────────

export const estadoDaRegua = (slug: string): Estado => estadoDaAutomacao(slug, ID_REGUA, process.env.CHATWOOT_REGUA_SLUGS);

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(ctx: ContextoChatwoot): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const deps: DepsDoCiclo = { armazem: armazemDoBanco(), chat: chatDoChatwoot(ctx), pausa: (ms) => new Promise((r) => setTimeout(r, ms)) };
    for (const [caixaTxt, slug] of Object.entries(CAIXAS_REGUA)) {
      const modo = estadoDaRegua(slug);
      if (modo === 'desligado') continue;
      try {
        const unit = await prisma.unit.findUnique({ where: { slug } });
        if (!unit) {
          logger.warn({ slug }, `${ID_REGUA}: unidade não encontrada`);
          continue;
        }
        const unidade: DadosDaUnidade = { nome: unit.name, pixKey: unit.pixKey, valorAntecipado: precosDaConsulta(unit)?.antecipado ?? null };
        const kommo = unit.kommoSubdomain && unit.kommoAccessToken ? cartaoNoKommoDaUnidade(unit) : undefined;
        await cicloDaCaixa({ ...deps, kommo, avisarGerente: avisoDaGerente(slug) }, Number(caixaTxt), slug, modo, unidade, new Date());
      } catch (err) {
        logger.warn({ err: String(err), slug }, `${ID_REGUA}: ciclo falhou — tento no próximo`);
      }
    }
  } finally {
    rodando = false;
  }
}

export function startChatwootReguaWorker(): void {
  if (timer) return;
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    logger.info(`${ID_REGUA}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  const ctx = criarContextoChatwoot(conta);
  primeira = setTimeout(() => void varrer(ctx), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_REGUA}: worker iniciado`);
}

export function stopChatwootReguaWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
