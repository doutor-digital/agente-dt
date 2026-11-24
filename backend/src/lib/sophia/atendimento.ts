/**
 * A regra do atendimento da Sophia: oferecer horário real, agendar, avisar o grupo, encaminhar ao Dr. Thiago.
 *
 * Tudo que toca o mundo entra por `Deps` (agenda, Kommo, grupo, relógio): o teste roda a regra inteira sem rede. A fábrica das
 * dependências de verdade está em `agent/sophia-tools.ts`.
 *
 * Estados (`config.ts`):
 *  - seco: LÊ a agenda (só leitura), decide e registra (trace + log + tela de simulações). NÃO cria evento, NÃO move cartão, NÃO manda ao grupo,
 *    NÃO manda o cartão de chegada. Quem confere a ordem das portas é o teste: cada efeito passa por `ligado()`.
 *  - ligado: faz tudo, nesta ordem — evento na Tramitação (se falhar, para e NÃO confirma), cartão para "4 - Análise agendada", grupo, cartão de chegada.
 *    Depois do evento criado, falha de cartão ou de grupo NÃO desfaz nada (o horário já está na agenda): fica no trace e no log, e a resposta
 *    ao modelo diz o que faltou.
 */
import { logger } from '../logger.js';
import type { Estado } from '../automacoes-estado.js';
import type { AcaoSimulada } from '../so-no-papel.js';
import { dataPorExtenso } from '../feriados.js';
import { type Advogado, type ChaveDoAdvogado, QUEM_AGENDA, advogado, etapaAnaliseAgendada, grupoInterno, linkDoMeet } from './config.js';
import { ErroDaAgenda, type AgendaDoEscritorio } from './agenda.js';
import { DURACAO_MIN, doisParaOferecer, dataLocal, ehHorarioDaGrade, gradeDoDia, horariosLivres, instante, somarDias, type SlotLivre } from './horarios.js';
import { avisoDoAgendamento, avisoDoThiago, descricaoDoEvento, modalidadeDoAtendimento, primeiroNome, tituloDoEvento, type MotivoDoThiago } from './texto.js';

export interface PedidoDeAgendamento {
  leadId: number;
  nomeDoCliente: string;
  cidade: string;
  estado?: string | null;
  caso: string;
  temLaudoEExames: boolean;
  situacaoNoInss: string;
  data: string;
  hora: string;
  advogado?: ChaveDoAdvogado;
}

export type ResultadoDaMover = 'moveu' | 'ja_na_etapa' | 'fora_do_funil' | 'terminal';

export interface Deps {
  slug: string;
  estado: () => Estado;
  agenda: AgendaDoEscritorio;
  agora: () => number;
  telefoneDoLead: (leadId: number) => Promise<string | null>;
  mover: (leadId: number, destino: { pipelineId: number; statusId: number }) => Promise<ResultadoDaMover>;
  /** true = mandou. Já registra a falha no log. */
  mandarNoGrupo: (grupo: string, texto: string, mencionar: string[]) => Promise<boolean>;
  linkDoCartao: (leadId: number) => string | null;
  /** Dedupe persistente de aviso (por lead e chave). */
  jaAvisou: (leadId: number, chave: string, janelaMs: number) => Promise<boolean>;
  marcarAviso: (leadId: number, chave: string) => Promise<void>;
  registrar: (tipo: 'TOOL_CALL' | 'KOMMO_ACTION' | 'ERROR' | 'THINKING', titulo: string, payload?: unknown) => Promise<void>;
  simular: (leadId: number, acao: AcaoSimulada, alvo: string, valor?: unknown) => void;
  /** Presencial: pede o cartão de chegada (foto + endereço + mapa) depois da confirmação. */
  pedirCartaoDeChegada: () => void;
  /** O carimbo "Agenda consultada em…" que o grafo usa para saber a idade da consulta. */
  carimbo: () => string;
}

export interface Resposta {
  ok: boolean;
  texto: string;
}

const DIAS_A_FRENTE = 14;
const SEM_HORARIO = 'NÃO cite nenhum horário e NÃO diga que vai agendar: diga que a equipe do escritório confirma o horário em instantes e passe o caso à equipe (pausar_ia).';

const ligado = (d: Deps) => d.estado() === 'ligado';

function advogadosQueAgendam(slug: string, so?: ChaveDoAdvogado): Advogado[] {
  return QUEM_AGENDA.filter((k) => !so || k === so).map((k) => advogado(slug, k));
}

/** Lê a ocupação de cada advogado; o que falhar fica de fora (e vai em `falhas`): agenda lida pela metade nunca vira "livre". */
async function ocupacoes(d: Deps, advs: Advogado[], de: string, ate: string) {
  const ocupado: Partial<Record<ChaveDoAdvogado, Array<{ inicio: number; fim: number }>>> = {};
  const falhas: string[] = [];
  const lidos: ChaveDoAdvogado[] = [];
  await Promise.all(
    advs.map(async (a) => {
      try {
        ocupado[a.chave] = await d.agenda.ocupacao(a, de, ate);
        lidos.push(a.chave);
      } catch (err) {
        falhas.push(`${a.chave}: ${err instanceof ErroDaAgenda ? err.message : String(err)}`);
      }
    }),
  );
  return { ocupado, lidos, falhas };
}

// ── Consultar horários ──────────────────────────────────────────────────────────────────────────────────────────

export async function consultarHorarios(d: Deps, a: { aPartirDe?: string; turno?: 'manha' | 'tarde' }): Promise<Resposta> {
  const agora = d.agora();
  const hoje = dataLocal(agora);
  const inicio = a.aPartirDe && a.aPartirDe > hoje ? a.aPartirDe : hoje;
  const advs = advogadosQueAgendam(d.slug);
  const { ocupado, lidos, falhas } = await ocupacoes(d, advs, inicio, somarDias(inicio, DIAS_A_FRENTE));
  if (falhas.length > 0) {
    logger.warn({ unit: d.slug, falhas }, 'sophia: não consegui ler a agenda de todos os advogados');
    await d.registrar('ERROR', `Sophia: agenda do escritório não lida (${falhas.length} de ${advs.length})`, { falhas });
  }
  if (lidos.length === 0) return { ok: false, texto: `Não consegui conferir a agenda dos advogados agora. ${SEM_HORARIO}` };

  let livres = horariosLivres({ agora, advogados: lidos, ocupado, diasAFrente: DIAS_A_FRENTE + (inicio > hoje ? Math.round((Date.parse(inicio) - Date.parse(hoje)) / 86_400_000) : 0) }).filter((s) => s.data >= inicio);
  if (a.turno) livres = livres.filter((s) => (a.turno === 'manha' ? s.hora < '12:00' : s.hora >= '12:00'));
  await d.registrar('TOOL_CALL', `Sophia: consultar horários a partir de ${inicio}${a.turno ? ` (${a.turno})` : ''}: ${livres.length} livre(s) nos próximos ${DIAS_A_FRENTE} dias`, {
    advogadosLidos: lidos,
    ofertados: doisParaOferecer(livres).map((s) => ({ data: s.data, hora: s.hora, advogado: s.advogado })),
  });
  if (livres.length === 0) {
    return { ok: true, texto: `Não há horário livre a partir de ${inicio} nos próximos ${DIAS_A_FRENTE} dias${a.turno ? ' neste turno' : ''}. ${SEM_HORARIO} ${d.carimbo()}` };
  }
  const dois = doisParaOferecer(livres);
  const porDia = new Map<string, string[]>();
  for (const s of dois) porDia.set(s.data, [...(porDia.get(s.data) ?? []), s.hora]);
  const frases = [...porDia].map(([dia, horas]) => `Horários CONFIRMADOS com a clínica em ${dataPorExtenso(dia)} (${dia}): ${horas.join(', ')}. `).join('');
  const quem = dois.map((s) => `${s.data} ${s.hora} = ${advogado(d.slug, s.advogado).nome}`).join('; ');
  return {
    ok: true,
    texto:
      frases +
      `Cada atendimento dura ${DURACAO_MIN} minutos. Ofereça EXATAMENTE estes dois horários, sem inventar outros. Quem atende (os dois advogados atendem qualquer caso; passe o advogado ao agendar): ${quem}. ` +
      d.carimbo(),
  };
}

// ── Agendar ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function verificarSlot(d: Deps, p: PedidoDeAgendamento): Promise<{ slot: SlotLivre } | { recusa: string }> {
  if (!ehHorarioDaGrade(p.data, p.hora)) {
    return { recusa: `RECUSADO: ${p.data} às ${p.hora} não é um horário de atendimento (seg–sex, 8h–12h e 14h–18h, de hora em hora, sem feriado). Chame consultar_horarios e ofereça os que ele devolver.` };
  }
  const advs = advogadosQueAgendam(d.slug, p.advogado);
  const { ocupado, lidos, falhas } = await ocupacoes(d, advs, p.data, p.data);
  if (falhas.length > 0 || lidos.length === 0) {
    await d.registrar('ERROR', 'Sophia: agenda não lida na hora de agendar — nada foi criado', { falhas });
    return { recusa: `ERRO: não consegui conferir a agenda agora, então NÃO agendei. ${SEM_HORARIO}` };
  }
  const slot = horariosLivres({ agora: d.agora(), advogados: lidos, ocupado, diasAFrente: 90 }).find((s) => s.data === p.data && s.hora === p.hora);
  if (!slot) return { recusa: 'RECUSADO: esse horário não está mais livre (ou já passou, ou falta menos de 2 horas). NÃO confirme. Chame consultar_horarios e ofereça outros dois.' };
  return { slot };
}

export async function agendarAtendimento(d: Deps, p: PedidoDeAgendamento): Promise<Resposta> {
  const estado = d.estado();
  if (estado === 'desligado') return { ok: false, texto: 'RECUSADO: a agenda da Sophia não está ativa neste escritório. Passe o caso à equipe (pausar_ia).' };
  if (!Number.isInteger(p.leadId) || p.leadId <= 0) return { ok: false, texto: 'RECUSADO: sem o número do cartão (leadId) não dá para agendar.' };
  const hojeMin = dataLocal(d.agora());
  if (p.data < hojeMin || p.data > somarDias(hojeMin, 90) || gradeDoDia(p.data).length === 0) {
    return { ok: false, texto: `RECUSADO: ${p.data} não é um dia de atendimento. Chame consultar_horarios.` };
  }

  // Idempotência (ligado): o mesmo evento já na agenda = a ferramenta foi chamada de novo; não cria outro e segue com o resto.
  const adv0 = p.advogado ? advogado(d.slug, p.advogado) : null;
  let jaCriado: Advogado | null = null;
  if (ligado(d) && adv0) {
    try {
      if (await d.agenda.jaExiste(adv0, tituloDoEvento(p.nomeDoCliente, adv0), instante(p.data, p.hora))) jaCriado = adv0;
    } catch {
      /* sem conseguir conferir, cai no recheck normal (que também lê a agenda e falha fechado) */
    }
  }

  let adv: Advogado;
  if (jaCriado) adv = jaCriado;
  else {
    const v = await verificarSlot(d, p);
    if ('recusa' in v) return { ok: false, texto: v.recusa };
    adv = advogado(d.slug, v.slot.advogado);
  }

  const modalidade = modalidadeDoAtendimento(p.cidade, p.estado);
  const meet = modalidade === 'online' ? linkDoMeet(d.slug) : null;
  const titulo = tituloDoEvento(p.nomeDoCliente, adv);
  const inicio = instante(p.data, p.hora);
  const resumo = { data: p.data, hora: p.hora, advogado: adv.chave, modalidade, leadId: p.leadId };
  const confirmacao =
    `Atendimento marcado para ${dataPorExtenso(p.data)} às ${p.hora} com ${adv.nome}, ${modalidade === 'presencial' ? 'presencial no escritório' : 'online pelo Google Meet'}. ` +
    (modalidade === 'online'
      ? meet
        ? `Link do Google Meet: ${meet}. `
        : 'O link do Google Meet ainda não está configurado: diga que a equipe envia o link por aqui antes do horário. '
      : 'O endereço do escritório segue numa mensagem à parte, enviada pelo sistema: não escreva o endereço. ') +
    `Dura ${DURACAO_MIN} minutos. Não prometa resultado nem benefício; o atendimento inicial é sem custo.`;

  // ── SECO: decide e registra, nada sai ──
  if (!ligado(d)) {
    await d.registrar('THINKING', `🧪 Sophia (só no papel): agendaria ${adv.nome} em ${p.data} ${p.hora} (${modalidade}); nada foi criado, movido nem enviado`, resumo);
    d.simular(p.leadId, 'mandaria', 'tramitacao:evento', { ...resumo, titulo });
    d.simular(p.leadId, 'moveria', 'etapa:4 - Análise agendada', resumo);
    d.simular(p.leadId, 'mandaria', 'grupo:aviso-do-agendamento', resumo);
    logger.info({ unit: d.slug, ...resumo }, 'sophia (seco): decidiu agendar, sem efeito');
    return { ok: true, texto: `${confirmacao} [MODO SECO: nada foi gravado na agenda, no cartão nem no grupo.]` };
  }

  // ── LIGADO ──
  const faltou: string[] = [];
  if (!jaCriado) {
    const telefone = await d.telefoneDoLead(p.leadId).catch(() => null);
    try {
      const criado = await d.agenda.criar(adv, {
        titulo,
        descricao: descricaoDoEvento({
          nomeDoCliente: p.nomeDoCliente,
          telefone,
          cidade: p.cidade,
          caso: p.caso,
          temLaudoEExames: p.temLaudoEExames,
          situacaoNoInss: p.situacaoNoInss,
          modalidade,
          linkDoMeet: meet,
        }),
        inicio,
        fim: inicio + DURACAO_MIN * 60_000,
      });
      await d.registrar('KOMMO_ACTION', `📅 Evento criado na Tramitação: ${adv.tratamento}, ${p.data} ${p.hora} (${modalidade})`, { ...resumo, eventoId: criado.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ unit: d.slug, ...resumo, err: msg }, 'sophia: evento NÃO criado na Tramitação — nada confirmado');
      await d.registrar('ERROR', `Sophia: evento não criado na Tramitação — ${msg.slice(0, 200)}`, resumo);
      return { ok: false, texto: `ERRO: não consegui gravar o atendimento na agenda, então NÃO está agendado. NÃO confirme o horário. ${SEM_HORARIO}` };
    }
  }

  // cartão para "4 - Análise agendada"
  const etapa = etapaAnaliseAgendada(d.slug);
  if (!etapa) {
    faltou.push('cartão não movido (etapa "4 - Análise agendada" sem configuração)');
    await d.registrar('ERROR', 'Sophia: SOPHIA_ETAPA_ANALISE_AGENDADA sem a etapa deste escritório — cartão não movido', resumo);
  } else {
    try {
      const r = await d.mover(p.leadId, etapa);
      await d.registrar('KOMMO_ACTION', `Cartão → 4 - Análise agendada (${r})`, { ...resumo, resultado: r });
    } catch (err) {
      faltou.push('cartão não movido');
      logger.warn({ unit: d.slug, leadId: p.leadId, err: String(err) }, 'sophia: cartão não foi movido');
      await d.registrar('ERROR', `Sophia: cartão não movido — ${String(err).slice(0, 200)}`, resumo);
    }
  }

  // aviso no grupo interno, marcando o advogado (uma vez por cartão e horário)
  const chaveAviso = `sophia-agendou:${p.data}:${p.hora}`;
  const grupo = grupoInterno(d.slug);
  if (!grupo) {
    faltou.push('grupo não avisado (SOPHIA_GRUPO_INTERNO sem este escritório)');
    await d.registrar('ERROR', 'Sophia: sem grupo interno configurado — a equipe não foi avisada do agendamento', resumo);
  } else if (await d.jaAvisou(p.leadId, chaveAviso, 24 * 3_600_000)) {
    await d.registrar('THINKING', 'Sophia: grupo já foi avisado deste horário (não repete)', resumo);
  } else {
    if (!adv.numero) logger.warn({ unit: d.slug, advogado: adv.chave }, 'sophia: advogado sem número em SOPHIA_ADVOGADOS — o grupo recebe o nome sem marcação');
    const mandou = await d.mandarNoGrupo(
      grupo,
      avisoDoAgendamento({
        primeiroNome: primeiroNome(p.nomeDoCliente),
        cidade: p.cidade,
        caso: p.caso,
        temLaudoEExames: p.temLaudoEExames,
        situacaoNoInss: p.situacaoNoInss,
        data: p.data,
        hora: p.hora,
        modalidade,
        advogado: adv,
      }),
      adv.numero ? [adv.numero] : [],
    );
    if (mandou) {
      await d.marcarAviso(p.leadId, chaveAviso);
      await d.registrar('KOMMO_ACTION', `📣 Grupo interno avisado (${adv.tratamento} marcado${adv.numero ? '' : ' só pelo nome'})`, resumo);
    } else {
      faltou.push('grupo não avisado');
      await d.registrar('ERROR', 'Sophia: o aviso no grupo interno falhou', resumo);
    }
  }

  if (modalidade === 'presencial') d.pedirCartaoDeChegada();
  return {
    ok: true,
    texto: confirmacao + (faltou.length ? ` [Interno, não diga ao cliente: ${faltou.join('; ')} — a equipe confere.]` : ''),
  };
}

// ── Dr. Thiago ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface PedidoParaOThiago {
  leadId: number;
  nomeDoCliente: string;
  cidade?: string | null;
  resumo: string;
  motivo: MotivoDoThiago;
}

const AVISO_DO_THIAGO_JANELA_MS = 6 * 3_600_000;

export async function encaminharAoThiago(d: Deps, p: PedidoParaOThiago): Promise<Resposta> {
  const estado = d.estado();
  if (estado === 'desligado') return { ok: false, texto: 'RECUSADO: o encaminhamento da Sophia não está ativo neste escritório. Passe o caso à equipe (pausar_ia).' };
  const falaAoCliente = 'Diga ao cliente que você vai avisar o Dr. Thiago e que ele entra em contato. NÃO ofereça horário e NÃO agende.';
  const resumo = { leadId: p.leadId, motivo: p.motivo };
  if (!ligado(d)) {
    await d.registrar('THINKING', `🧪 Sophia (só no papel): avisaria o Dr. Thiago no grupo (${p.motivo}); nada foi enviado`, resumo);
    d.simular(p.leadId, 'mandaria', 'grupo:aviso-dr-thiago', resumo);
    return { ok: true, texto: `Anotado. ${falaAoCliente} [MODO SECO: nada foi enviado ao grupo.]` };
  }
  const grupo = grupoInterno(d.slug);
  if (!grupo) {
    await d.registrar('ERROR', 'Sophia: sem grupo interno configurado — o Dr. Thiago NÃO foi avisado', resumo);
    return { ok: false, texto: 'ERRO: não consegui avisar o Dr. Thiago. NÃO prometa que ele vai ligar: diga que a equipe retorna e passe o caso à equipe (pausar_ia).' };
  }
  const chave = 'sophia-thiago';
  if (await d.jaAvisou(p.leadId, chave, AVISO_DO_THIAGO_JANELA_MS)) {
    await d.registrar('THINKING', 'Sophia: o Dr. Thiago já foi avisado deste cartão há pouco (não repete)', resumo);
    return { ok: true, texto: `O Dr. Thiago já foi avisado. ${falaAoCliente}` };
  }
  const thiago = advogado(d.slug, 'thiago');
  if (!thiago.numero) logger.warn({ unit: d.slug }, 'sophia: Dr. Thiago sem número em SOPHIA_ADVOGADOS — o grupo recebe o nome sem marcação');
  const mandou = await d.mandarNoGrupo(
    grupo,
    avisoDoThiago({ primeiroNome: primeiroNome(p.nomeDoCliente), cidade: p.cidade ?? null, resumo: p.resumo, motivo: p.motivo, linkDoCartao: d.linkDoCartao(p.leadId), advogado: thiago }),
    thiago.numero ? [thiago.numero] : [],
  );
  if (!mandou) {
    await d.registrar('ERROR', 'Sophia: o aviso ao Dr. Thiago no grupo falhou', resumo);
    return { ok: false, texto: 'ERRO: não consegui avisar o Dr. Thiago. NÃO prometa que ele vai ligar: diga que a equipe retorna e passe o caso à equipe (pausar_ia).' };
  }
  await d.marcarAviso(p.leadId, chave);
  await d.registrar('KOMMO_ACTION', '📣 Dr. Thiago avisado no grupo interno', resumo);
  return { ok: true, texto: `Dr. Thiago avisado. ${falaAoCliente}` };
}

