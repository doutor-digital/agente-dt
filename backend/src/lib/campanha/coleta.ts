/**
 * Coleta do placar de uma campanha: Kommo (etiquetas, transmissões, conversas), nosso banco (texto das
 * mensagens), franquia (agenda e tratamentos) e Meta (cor do número). As contas ficam em metricas.ts.
 *
 * Uma unidade com erro não derruba as outras: ela volta com `avisos` e sem números, e a página mostra que
 * ficou de fora — nunca um zero que parece resultado.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { createKommoClient, type KommoLead } from '../../services/kommo.service.js';
import { searchClients, searchSchedules, searchTreatments } from '../../services/spine.service.js';
import { credenciaisDaUnidade } from '../whatsapp-meta.js';
import { normalizarQualidade, type Qualidade } from '../qualidade-do-numero.js';
import type { Campanha } from './campanhas.js';
import {
  compararNomes,
  envioPorRajada,
  finalDoTelefone,
  grupoDaEtiqueta,
  lerConversa,
  mediana,
  resultadoNaAgenda,
  somarTransmissoes,
  type AvaliacaoNaAgenda,
  type EventoDeChat,
  type GrupoDeEtiqueta,
  type MensagemGuardada,
  type Placar,
  type TratamentoNaFranquia,
  type Transmissao,
} from './metricas.js';

const FUSO = 'America/Sao_Paulo';
const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const VERSAO = process.env.META_GRAPH_VERSION || 'v23.0';

export interface LinhaDoPlacar extends Placar {
  grupo: string;
  rotulo: string;
  ordem: number;
  /** Dia do envio do grupo nesta unidade (YYYY-MM-DD), pela 1ª transmissão; null se ainda não saiu. */
  diaDoEnvio: string | null;
  /** O "respondeu" do relatório do Kommo, para comparar com o que lemos nas conversas. */
  respondidasKommo: number | null;
}

export interface ConversaRespondida {
  grupo: string;
  /** Só o primeiro nome: a página circula entre gestores. */
  nome: string;
  respondeuEm: number;
  sofiaMin: number | null;
  equipeMin: number | null;
  saiu: boolean;
  agendou: boolean;
  compareceu: boolean;
}

export interface PlacarDaUnidade {
  unidade: string;
  nome: string;
  qualidade: Qualidade | null;
  limiteDeEnvio: string | null;
  linhas: LinhaDoPlacar[];
  conversas: ConversaRespondida[];
  avisos: string[];
  coletadoEm: string;
}

export function diaLocal(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function inicioDoDiaUnix(dia: string): number {
  return Math.floor(new Date(`${dia}T00:00:00-03:00`).getTime() / 1000);
}

function somarDias(dia: string, n: number): string {
  return new Date(new Date(`${dia}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function primeiroNome(nome: string | null | undefined): string {
  const t = (nome ?? '').trim().split(/\s+/)[0] ?? '';
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '—';
}

async function lerQualidade(unidades: Unit[]): Promise<{ qualidade: Qualidade | null; limite: string | null }> {
  const u = unidades.find((x) => credenciaisDaUnidade(x));
  const cred = u ? credenciaisDaUnidade(u) : null;
  if (!cred) return { qualidade: null, limite: null };
  try {
    const r = await fetch(`${GRAPH}/${VERSAO}/${cred.phoneNumberId}?fields=quality_rating,messaging_limit_tier`, {
      headers: { Authorization: `Bearer ${cred.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const d = (await r.json()) as { quality_rating?: string; messaging_limit_tier?: string; error?: unknown };
    if (!r.ok || d.error) return { qualidade: null, limite: null };
    return { qualidade: normalizarQualidade(d.quality_rating), limite: d.messaging_limit_tier ?? null };
  } catch {
    return { qualidade: null, limite: null };
  }
}

export async function coletarUnidade(campanha: Campanha, slug: string, agora = new Date()): Promise<PlacarDaUnidade> {
  const coletadoEm = agora.toISOString();
  const unit = await prisma.unit.findUnique({ where: { slug } });
  const vazio = (aviso: string): PlacarDaUnidade => ({
    unidade: slug, nome: unit?.name ?? slug, qualidade: null, limiteDeEnvio: null, linhas: [], conversas: [], avisos: [aviso], coletadoEm,
  });
  if (!unit?.kommoSubdomain || !unit.kommoAccessToken) return vazio('unidade sem Kommo configurado');

  // A unidade do resgate mora na mesma conta: as conversas dela também são da campanha.
  const daConta = await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain } });
  const kommo = createKommoClient(unit);
  const avisos: string[] = [];
  const desde = inicioDoDiaUnix(campanha.inicio);

  // 1. Etiquetas da campanha, agrupadas por dia de envio.
  const grupos = new Map<string, { grupo: GrupoDeEtiqueta; tags: Array<{ id: number; name: string }> }>();
  for (const t of await kommo.buscarEtiquetas(campanha.buscaDeEtiquetas)) {
    const g = grupoDaEtiqueta(t.name, campanha.grupos);
    if (!g) continue;
    const atual = grupos.get(g.chave) ?? { grupo: g, tags: [] };
    atual.tags.push({ id: t.id, name: t.name });
    grupos.set(g.chave, atual);
  }
  if (grupos.size === 0) return { ...vazio('nenhuma etiqueta da campanha nesta conta'), nome: unit.name };

  // 2. Cartões de cada grupo e os contatos.
  const cartoesDoGrupo = new Map<string, KommoLead[]>();
  for (const [chave, { tags }] of grupos) {
    const vistos = new Map<number, KommoLead>();
    for (const t of tags) for (const l of await kommo.listLeadsComEtiqueta(t.name)) vistos.set(l.id, l);
    cartoesDoGrupo.set(chave, [...vistos.values()]);
  }
  const todos = [...cartoesDoGrupo.values()].flat();
  const contatoDoCartao = new Map<number, number>();
  for (const l of todos) {
    const c = l._embedded?.contacts?.find((x) => x.is_main) ?? l._embedded?.contacts?.[0];
    if (c) contatoDoCartao.set(l.id, c.id);
  }
  const contatos = await kommo.contatosBasicos([...contatoDoCartao.values()]);

  // 3. Conversas: hora das mensagens (Kommo) e texto (nosso banco).
  const eventos = await kommo.eventosDeChat([...contatoDoCartao.values()], desde);
  const eventosPorCartao = new Map<number, EventoDeChat[]>();
  for (const e of eventos) eventosPorCartao.set(e.leadId, [...(eventosPorCartao.get(e.leadId) ?? []), e]);
  const msgs = await prisma.message.findMany({
    where: {
      createdAt: { gte: new Date(desde * 1000) },
      conversation: { unitId: { in: daConta.map((u) => u.id) }, leadId: { in: todos.map((l) => String(l.id)) } },
    },
    select: { role: true, content: true, createdAt: true, conversation: { select: { leadId: true } } },
  });
  const msgsPorCartao = new Map<number, MensagemGuardada[]>();
  for (const m of msgs) {
    const id = Number(m.conversation.leadId);
    const papel = m.role === 'assistant' || m.role === 'system' ? m.role : 'user';
    msgsPorCartao.set(id, [...(msgsPorCartao.get(id) ?? []), { leadId: id, papel, texto: m.content, em: Math.floor(m.createdAt.getTime() / 1000) }]);
  }

  // 4. Relatório das transmissões.
  let transmissoes: Transmissao[] | null = null;
  const inicioDoEnvio = new Map<string, number>();
  try {
    const lista = await kommo.listTransmissoes();
    // O Kommo responde "This is a private API" ao token: o relatório (entregues, lidas, custo) só abre na tela.
    if (lista !== null) {
      transmissoes = lista.map((b) => ({
        tagIds: (b.filter?.tag ?? []).map(Number).filter(Number.isFinite),
        enviadas: b.stats?.sent ?? 0,
        entregues: b.stats?.delivered ?? 0,
        lidas: b.stats?.read ?? 0,
        respondidas: b.stats?.responded ?? 0,
        falhas: b.stats?.failed ?? 0,
        custoUsd: b.stats?.cost ?? 0,
      }));
      for (const [chave, { tags }] of grupos) {
        const ids = new Set(tags.map((t) => t.id));
        const horas = lista
          .filter((b) => (b.filter?.tag ?? []).some((x) => ids.has(Number(x))) && typeof b.scheduled_at === 'number')
          .map((b) => b.scheduled_at as number);
        if (horas.length) inicioDoEnvio.set(chave, Math.min(...horas));
      }
    }
  } catch (err) {
    avisos.push(`transmissões: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. Franquia: avaliações e tratamentos desde o início da campanha.
  let avaliacoes: AvaliacaoNaAgenda[] = [];
  let tratamentos: TratamentoNaFranquia[] = [];
  const confirmados = new Map<string, Set<string>>(); // nome na franquia → finais de telefone
  if (unit.spineToken) {
    const ag = await searchSchedules(unit, { initialDate: campanha.inicio, endDate: somarDias(campanha.fim, 45) });
    if (ag.ok && ag.data) {
      avaliacoes = ag.data.schedules
        .filter((s) => /AVALIA/i.test(s.categoryName ?? '') && s.idSchedule != null && s.clientName && s.dayLocal)
        .map((s) => ({ idSchedule: s.idSchedule as number, nome: s.clientName as string, status: s.statusName ?? '', dia: s.dayLocal as string }));
    } else avisos.push(`agenda da franquia: ${ag.error ?? 'sem resposta'}`);
    const tr = await searchTreatments(unit, { de: campanha.inicio, ate: diaLocal(agora) });
    if (tr.ok && tr.data) {
      tratamentos = tr.data.treatments
        .filter((t) => t.clientName && t.created)
        .map((t) => ({ idClient: t.idClient, nome: t.clientName as string, preco: Number(t.price) || 0, criado: (t.created as string).slice(0, 10) }));
    } else avisos.push(`tratamentos da franquia: ${tr.error ?? 'sem resposta'}`);
  } else avisos.push('unidade sem token da franquia: agendamentos e tratamentos ficam em branco');

  /** Nome parcial só vale com o telefone batendo — a busca na franquia devolve o WhatsApp do cadastro. */
  async function mesmaPessoa(nomeFranquia: string, nomeKommo: string | null, tel: string | null): Promise<boolean> {
    const c = compararNomes(nomeKommo, nomeFranquia);
    if (c === 'exato') return true;
    if (c !== 'parcial') return false;
    const fim = finalDoTelefone(tel);
    if (!fim) return false;
    if (!confirmados.has(nomeFranquia)) {
      const r = await searchClients(unit!, nomeFranquia, 10);
      confirmados.set(nomeFranquia, new Set((r.data?.clients ?? []).map((x) => finalDoTelefone(x.whatsapp)).filter((x): x is string => !!x)));
    }
    return confirmados.get(nomeFranquia)!.has(fim);
  }

  // 6. O placar de cada grupo.
  const linhas: LinhaDoPlacar[] = [];
  const conversas: ConversaRespondida[] = [];
  for (const [chave, { grupo, tags }] of grupos) {
    const cartoes = cartoesDoGrupo.get(chave) ?? [];
    const envios = envioPorRajada(cartoes.flatMap((l) => eventosPorCartao.get(l.id) ?? []), desde, cartoes.length);
    const primeiro = Math.min(inicioDoEnvio.get(chave) ?? Infinity, ...envios.values());
    const diaDoEnvio = Number.isFinite(primeiro) ? diaLocal(new Date(primeiro * 1000)) : null;
    let responderam = 0, sairam = 0, agendaram = 0, compareceram = 0, nTrat = 0, receita = 0, equipeEntrou = 0;
    const sofiaMins: number[] = [];
    const equipeMins: number[] = [];
    for (const l of cartoes) {
      const contato = contatos.get(contatoDoCartao.get(l.id) ?? -1) ?? { nome: null, telefone: null };
      const envio = envios.get(l.id);
      const conv = envio != null
        ? lerConversa(envio, eventosPorCartao.get(l.id) ?? [], msgsPorCartao.get(l.id) ?? [])
        : { enviadaEm: null, respondeuEm: null, sofiaMin: null, equipeMin: null, saiu: false };
      let agendou = false;
      let compareceu = false;
      if (diaDoEnvio) {
        const daPessoa: AvaliacaoNaAgenda[] = [];
        for (const a of avaliacoes) if (a.dia >= diaDoEnvio && (await mesmaPessoa(a.nome, contato.nome, contato.telefone))) daPessoa.push(a);
        ({ agendou, compareceu } = resultadoNaAgenda(daPessoa, grupo, diaDoEnvio));
      }
      if (diaDoEnvio) {
        for (const t of tratamentos.filter((x) => x.criado >= diaDoEnvio)) {
          if (!(await mesmaPessoa(t.nome, contato.nome, contato.telefone))) continue;
          nTrat += 1;
          receita += t.preco;
        }
      }
      if (agendou) agendaram += 1;
      if (compareceu) compareceram += 1;
      if (conv.saiu) sairam += 1;
      if (conv.respondeuEm != null) {
        responderam += 1;
        if (conv.sofiaMin != null) sofiaMins.push(conv.sofiaMin);
        if (conv.equipeMin != null) { equipeEntrou += 1; equipeMins.push(conv.equipeMin); }
        conversas.push({
          grupo: chave, nome: primeiroNome(contato.nome), respondeuEm: conv.respondeuEm, sofiaMin: conv.sofiaMin,
          equipeMin: conv.equipeMin, saiu: conv.saiu, agendou, compareceu,
        });
      }
    }
    const t = somarTransmissoes(transmissoes, tags.map((x) => x.id));
    linhas.push({
      grupo: chave, rotulo: grupo.rotulo, ordem: grupo.ordem, diaDoEnvio,
      naTransmissao: cartoes.length,
      // Com o relatório do Kommo (só na tela), vale o dele; sem, conta-se quem recebeu na rajada.
      enviadas: t.enviadas ?? envios.size, entregues: t.entregues, lidas: t.lidas, falhas: t.falhas, custoUsd: t.custoUsd,
      respondidasKommo: t.respondidasKommo,
      responderam, sairam, agendaram, compareceram, tratamentos: nTrat, receita,
      sofiaMinMediana: mediana(sofiaMins), equipeEntrou, equipeMinMediana: mediana(equipeMins),
    });
  }
  linhas.sort((a, b) => a.ordem - b.ordem);

  const { qualidade, limite } = await lerQualidade(daConta);
  return { unidade: slug, nome: unit.name, qualidade, limiteDeEnvio: limite, linhas, conversas, avisos, coletadoEm };
}

/** Cotação do dólar para mostrar o custo em reais. Falhou, fica null e a página mostra só US$. */
export async function cotacaoDoDolar(): Promise<number | null> {
  try {
    const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { signal: AbortSignal.timeout(10_000) });
    const d = (await r.json()) as { USDBRL?: { bid?: string } };
    const v = Number(d.USDBRL?.bid);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Coleta todas as unidades e grava a foto do dia (refazer no mesmo dia sobrescreve). */
export async function coletarEGravar(campanha: Campanha, agora = new Date()): Promise<{ dia: string; unidades: number; comAviso: number }> {
  const dia = diaLocal(agora);
  const cambio = await cotacaoDoDolar();
  let comAviso = 0;
  for (const slug of campanha.unidades) {
    let placar: PlacarDaUnidade;
    try {
      placar = await coletarUnidade(campanha, slug, agora);
    } catch (err) {
      logger.warn({ err, slug, campanha: campanha.id }, 'placar de campanha: coleta da unidade falhou');
      placar = { unidade: slug, nome: slug, qualidade: null, limiteDeEnvio: null, linhas: [], conversas: [], avisos: [`coleta falhou: ${err instanceof Error ? err.message : String(err)}`], coletadoEm: agora.toISOString() };
    }
    if (placar.avisos.length) comAviso += 1;
    const dados = JSON.parse(JSON.stringify({ ...placar, cambio }));
    await prisma.campanhaPlacar.upsert({
      where: { campanha_unidade_dia: { campanha: campanha.id, unidade: slug, dia } },
      create: { campanha: campanha.id, unidade: slug, dia, dados },
      update: { dados },
    });
  }
  logger.info({ campanha: campanha.id, dia, unidades: campanha.unidades.length, comAviso }, 'placar de campanha gravado');
  return { dia, unidades: campanha.unidades.length, comAviso };
}
