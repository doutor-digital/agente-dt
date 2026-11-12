/**
 * AGENDA DA FRANQUIA → conversa do Chatwoot (pedido do João, 12/11/2026) — automação `chatwoot-agenda`, padrão DESLIGADO.
 *
 * A régua do Chatwoot (véspera, dia, preparo, falta, pós-consulta) depende de `data_consulta`, `hora_consulta` e `situacao_consulta`
 * na conversa. Em vez de alguém digitar, este worker lê a agenda da franquia (CRM Spine) da unidade e preenche.
 *
 * Como casa agendamento → conversa: a agenda só traz o NOME do paciente (sem telefone). Busca o nome na franquia
 * (`/api/clients/search`), pega o WhatsApp do cadastro com o nome IGUAL (nome repetido com telefones diferentes = não casa) e
 * procura a conversa da caixa com o mesmo telefone (DDI+DDD e 8 últimos dígitos: com e sem o 9).
 *
 * Qual agendamento vale por pessoa: o PRÓXIMO ainda de pé (hoje em diante); sem nenhum, o mais recente que já passou (para marcar
 * Atendido / Não compareceu). Grava só o que mudou.
 *  - SECO: deixa NOTA PRIVADA «🧪 [SECO] Agenda da franquia: gravaria …» (uma vez por mudança).
 *  - LIGADO: grava os atributos (mantendo os outros) e deixa nota curta do que mudou.
 * Lê de ontem até 14 dias à frente, a cada 15 min.
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { mesmoTelefone } from './chatwoot-lida.js';
import { normalizar } from './franquia-sync.js';
import { desfechoDaAgenda } from './franquia-calendario.js';
import { searchClients, searchSchedules, somarDias, type SpineSchedule } from '../services/spine.service.js';

export const ID_AGENDA = 'chatwoot-agenda';
const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_MS = 200_000;
const DIAS_A_FRENTE = 14;
const VALIDADE_NOME_MS = 6 * 3600_000;
const MAX_PAGINAS = 40;
const CATEGORIAS = ['Avaliação', 'Sessão', 'Retorno', 'Retorno com exames', 'Retorno após tratamento'];

export interface Desejado {
  data_consulta: string;
  hora_consulta: string | null;
  situacao_consulta: string;
  categoria_consulta: string | null;
}

/** Situação da franquia → a lista do Chatwoot (Agendado, Confirmado, Atendido, Não compareceu, Remarcado, Desmarcado). */
export function situacaoDoChatwoot(s: Pick<SpineSchedule, 'statusName'> & { idStatus?: number | null }): string {
  const d = desfechoDaAgenda(s.statusName, 'fechar', s.idStatus ?? null);
  if (d === 'atendido') return 'Atendido';
  if (d === 'faltou') return 'Não compareceu';
  if (d === 'desmarcado') return 'Desmarcado';
  if (d === 'remarcado') return 'Remarcado';
  return normalizar(s.statusName).includes('confirm') ? 'Confirmado' : 'Agendado';
}

export function categoriaDoChatwoot(nome: string | null | undefined): string | null {
  const n = normalizar(nome);
  if (!n) return null;
  // a mais específica primeiro ("retorno após tratamento" antes de "retorno")
  for (const c of [...CATEGORIAS].sort((a, b) => b.length - a.length)) if (n.includes(normalizar(c))) return c;
  if (n.includes('consulta') || n.includes('avalia')) return 'Avaliação';
  return null;
}

/** O agendamento que vale para a pessoa: o próximo de pé; sem ele, o mais recente que passou. */
export function agendamentoQueVale(lista: SpineSchedule[], hoje: string): SpineSchedule | null {
  const comDia = lista.filter((s) => s.dayLocal);
  const dePe = comDia
    .filter((s) => s.dayLocal! >= hoje && ['Agendado', 'Confirmado'].includes(situacaoDoChatwoot(s)))
    .sort((a, b) => `${a.dayLocal} ${a.timeLocal ?? ''}`.localeCompare(`${b.dayLocal} ${b.timeLocal ?? ''}`));
  if (dePe.length) return dePe[0]!;
  const passados = comDia.filter((s) => s.dayLocal! <= hoje).sort((a, b) => `${b.dayLocal} ${b.timeLocal ?? ''}`.localeCompare(`${a.dayLocal} ${a.timeLocal ?? ''}`));
  return passados[0] ?? null;
}

export function desejadoDe(s: SpineSchedule): Desejado | null {
  if (!s.dayLocal) return null;
  const hora = s.timeLocal && /^\d{2}:\d{2}/.test(s.timeLocal) ? s.timeLocal.slice(0, 5) : null;
  return { data_consulta: s.dayLocal, hora_consulta: hora, situacao_consulta: situacaoDoChatwoot(s), categoria_consulta: categoriaDoChatwoot(s.categoryName) };
}

/** O que muda nos atributos da conversa (só chaves com valor novo). Vazio = nada a fazer. */
export function mudancas(atual: Record<string, unknown>, d: Desejado): Record<string, string> {
  const o: Record<string, string> = {};
  const dataAtual = String(atual.data_consulta ?? '').slice(0, 10);
  if (dataAtual !== d.data_consulta) o.data_consulta = d.data_consulta;
  if (d.hora_consulta && String(atual.hora_consulta ?? '') !== d.hora_consulta) o.hora_consulta = d.hora_consulta;
  if (String(atual.situacao_consulta ?? '') !== d.situacao_consulta) o.situacao_consulta = d.situacao_consulta;
  if (d.categoria_consulta && String(atual.categoria_consulta ?? '') !== d.categoria_consulta) o.categoria_consulta = d.categoria_consulta;
  return o;
}

const NOMES: Record<string, string> = { data_consulta: 'data', hora_consulta: 'hora', situacao_consulta: 'situação', categoria_consulta: 'categoria' };
export function descricao(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `${NOMES[k] ?? k} = ${k === 'data_consulta' ? v.split('-').reverse().join('/') : v}`)
    .join(' · ');
}

export interface ConversaDaCaixa {
  id: number;
  telefone: string;
  attrs: Record<string, unknown>;
  atividade: number;
}

/** Junta agendamentos por pessoa e casa com as conversas pelo telefone. `whatsDoNome` devolve o(s) WhatsApp do cadastro com o nome igual. */
export function casar(
  agenda: SpineSchedule[],
  conversas: ConversaDaCaixa[],
  whatsDoNome: (nome: string) => string[] | null,
  hoje: string,
): Array<{ conversa: ConversaDaCaixa; muda: Record<string, string>; nome: string }> {
  const porNome = new Map<string, SpineSchedule[]>();
  for (const s of agenda) {
    const n = normalizar(s.clientName);
    if (!n) continue;
    porNome.set(n, [...(porNome.get(n) ?? []), s]);
  }
  const saida: Array<{ conversa: ConversaDaCaixa; muda: Record<string, string>; nome: string }> = [];
  for (const [nome, lista] of porNome) {
    const whats = whatsDoNome(nome);
    // sem cadastro, ou o mesmo nome com telefones diferentes: não dá para saber quem é
    if (!whats || whats.length !== 1) continue;
    const alvo = conversas.filter((c) => mesmoTelefone(c.telefone, whats[0]!)).sort((a, b) => b.atividade - a.atividade)[0];
    if (!alvo) continue;
    const s = agendamentoQueVale(lista, hoje);
    const d = s ? desejadoDe(s) : null;
    if (!d) continue;
    const muda = mudancas(alvo.attrs, d);
    if (Object.keys(muda).length) saida.push({ conversa: alvo, muda, nome: lista[0]!.clientName ?? nome });
  }
  return saida;
}

/** O(s) WhatsApp do cadastro cujo nome é IGUAL (normalizado). null = a busca falhou; [] = ninguém. */
export function whatsDoCadastro(clientes: Array<{ name: string | null; whatsapp: string | null }>, nome: string): string[] {
  const n = normalizar(nome);
  const fones = new Set<string>();
  for (const c of clientes) {
    if (normalizar(c.name) !== n) continue;
    const d = String(c.whatsapp ?? '').replace(/\D/g, '');
    if (d.length >= 10) fones.add(d.length <= 11 ? `55${d}` : d);
  }
  return [...fones];
}

// ── o worker ───────────────────────────────────────────────────────────────────────────────────────

const cacheNome = new Map<string, { fones: string[]; ate: number }>();
const notasFeitas = new Set<string>();

async function conversasDaCaixa(ctx: ContextoChatwoot, caixa: number): Promise<ConversaDaCaixa[]> {
  const saida: ConversaDaCaixa[] = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const r = (await chamar(ctx, 'GET', 'conversations', { query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(p) } })) as {
      data?: { payload?: any[] };
    } | null;
    const lista = r?.data?.payload ?? [];
    if (!lista.length) break;
    for (const c of lista) {
      const tel = String(c?.meta?.sender?.phone_number ?? '');
      if (!tel || /@g\.us$/i.test(String(c?.meta?.sender?.identifier ?? ''))) continue;
      saida.push({ id: Number(c.id), telefone: tel, attrs: c?.custom_attributes ?? {}, atividade: Number(c?.last_activity_at) || 0 });
    }
  }
  return saida;
}

const hojeEm = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export async function cicloDaAgenda(ctx: ContextoChatwoot, caixa: number, slug: string, modo: Exclude<Estado, 'desligado'>): Promise<{ agenda: number; casadas: number; gravadas: number }> {
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit?.spineToken) return { agenda: 0, casadas: 0, gravadas: 0 };
  const hoje = hojeEm(unit.spineTimezone || 'America/Belem');
  const r = await searchSchedules(unit, { initialDate: somarDias(hoje, -1), endDate: somarDias(hoje, DIAS_A_FRENTE), rowsPerPage: 100 });
  if (!r.ok || !r.data) {
    logger.warn({ slug, erro: r.error }, `${ID_AGENDA}: não li a agenda da franquia`);
    return { agenda: 0, casadas: 0, gravadas: 0 };
  }
  const agenda = r.data.schedules;
  // nomes da agenda → WhatsApp do cadastro (com cache de 6 h)
  const nomes = [...new Set(agenda.map((s) => normalizar(s.clientName)).filter(Boolean))];
  const fonesDe = new Map<string, string[] | null>();
  for (const n of nomes) {
    const k = `${slug}:${n}`;
    const c = cacheNome.get(k);
    if (c && c.ate > Date.now()) {
      fonesDe.set(n, c.fones);
      continue;
    }
    const original = agenda.find((s) => normalizar(s.clientName) === n)?.clientName ?? n;
    const busca = await searchClients(unit, original, 20);
    if (!busca.ok || !busca.data) {
      fonesDe.set(n, null);
      continue;
    }
    const fones = whatsDoCadastro(busca.data.clients, original);
    cacheNome.set(k, { fones, ate: Date.now() + VALIDADE_NOME_MS });
    fonesDe.set(n, fones);
    await new Promise((ok) => setTimeout(ok, 250));
  }
  const conversas = await conversasDaCaixa(ctx, caixa);
  const plano = casar(agenda, conversas, (n) => fonesDe.get(n) ?? null, hoje);
  let gravadas = 0;
  for (const { conversa, muda, nome } of plano) {
    const chave = `${conversa.id}|${JSON.stringify(muda)}`;
    try {
      if (modo === 'seco') {
        if (notasFeitas.has(chave)) continue;
        await chamar(ctx, 'POST', `conversations/${conversa.id}/messages`, {
          corpo: { content: `🧪 [SECO] Agenda da franquia (${nome}): gravaria ${descricao(muda)}`, message_type: 'outgoing', private: true },
        });
        notasFeitas.add(chave);
      } else {
        await chamar(ctx, 'POST', `conversations/${conversa.id}/custom_attributes`, { corpo: { custom_attributes: { ...conversa.attrs, ...muda } } });
        await chamar(ctx, 'POST', `conversations/${conversa.id}/messages`, {
          corpo: { content: `📅 Agenda da franquia: ${descricao(muda)}`, message_type: 'outgoing', private: true },
        });
      }
      gravadas++;
    } catch (err) {
      logger.warn({ err: String(err), slug, conversa: conversa.id }, `${ID_AGENDA}: não consegui gravar`);
    }
  }
  logger.info({ slug, caixa, modo, agenda: agenda.length, casadas: plano.length, gravadas }, `${ID_AGENDA}: ciclo`);
  return { agenda: agenda.length, casadas: plano.length, gravadas };
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(ctx: ContextoChatwoot): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    for (const [caixaTxt, slug] of Object.entries(CAIXAS_REGUA)) {
      const modo = estadoDaAutomacao(slug, ID_AGENDA, process.env.CHATWOOT_AGENDA_SLUGS);
      if (modo === 'desligado') continue;
      try {
        await cicloDaAgenda(ctx, Number(caixaTxt), slug, modo);
      } catch (err) {
        logger.warn({ err: String(err), slug }, `${ID_AGENDA}: ciclo falhou`);
      }
    }
  } finally {
    rodando = false;
  }
}

export function startChatwootAgendaWorker(): void {
  if (timer) return;
  const conta = contaChatwootDoAmbiente();
  if (!conta) return;
  const ctx = criarContextoChatwoot(conta);
  setTimeout(() => void varrer(ctx), PRIMEIRA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_AGENDA}: worker iniciado`);
}
