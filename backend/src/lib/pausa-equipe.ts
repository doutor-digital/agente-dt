/**
 * A EQUIPE FALOU, A SOFIA PARA (prioridade 3 da lista de 21/10/2026).
 *
 * O problema: com a equipe já conversando com o paciente, a Sofia seguia respondendo por cima —
 * contradizia horário e valor e cobrava Pix de quem já tinha pago. Medido em 01–20/10: em 399 de 414
 * conversas em que a equipe falou, a IA voltou a responder em até 6 h. Caso real: Bebedouro, lead
 * 6374469 — a secretária se apresentou pelo celular às 10:25 e a Sofia respondeu às 12:28, 12:36, 12:55…
 *
 * POR QUE A AUTO-PAUSA ANTIGA NUNCA DISPAROU. Ela mora no webhook (`author.type === 'user'` numa
 * mensagem OUTGOING), mas as contas assinam só `add_message` — a mensagem que ENTRA. No log de
 * produção de 20/10 (09:27–14:56, 343 respostas da Sofia) há zero linhas "sonda-sla: mensagem de saida
 * recebida", e o monitor de entrega avisa "NENHUMA confirmação recebida". A doc do Kommo descreve um
 * evento à parte ("Outgoing message sent", chave `outgoing_message`, autor `internal`) que cobre só o que
 * sai DE DENTRO do Kommo (usuário ou Salesbot) — a mensagem do celular da clínica (WhatsApp Business em
 * coexistência) não sai do Kommo.
 *
 * QUEM VÊ TUDO: a conversa oficial (`/talks/{id}/messages`), a mesma que a Sofia já lê antes de
 * responder. Lá aparece a fala da equipe pelo Kommo web, pelo app do Kommo (usuário com nome) e pelo
 * celular (autor "WhatsApp Business", que o Kommo marca como robô — ver kommo-talks-normalizar.ts).
 *
 * O QUE CONTA COMO "A EQUIPE TEM A PALAVRA" (`equipeComAPalavra`):
 *  - uma fala HUMANA da equipe (não robô: Salesbot, régua, transmissão já saem como 'sofia'; e não a
 *    resposta automática do próprio WhatsApp Business — saudação e ausência, ver `ehRespostaAutomatica`);
 *  - DEPOIS da última mensagem que o agente mandou (se a Sofia falou depois, a conversa voltou para ela);
 *  - nas últimas 24 h;
 *  - e sem ninguém ter mexido na caixinha "Pausar IA" depois dela (desmarcar = devolver à Sofia; a fala
 *    antiga não pausa de novo, uma fala nova pausa).
 *
 * O QUE ACONTECE: na porta (antes de gerar) e na trava de antes de ENVIAR, a Sofia não responde, marca
 * "Pausar IA", carimba "assumido por humano" e cancela a reativação de 30 min daquele handoff — gente já
 * assumiu. A reativação também passou a conferir a conversa oficial (`falaDaEquipeDesde`).
 *
 * Atrás da chave `pausa-equipe` (PAUSA_EQUIPE_SLUGS), nascendo em "só no papel" na rede toda. Fora da
 * chave, sempre ligado: a trava de antes de enviar para pausa explícita (caixinha, pausa com data, pausa
 * da unidade) e a reativação que respeita a fala da equipe.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { pausouSozinhaDesde } from './pausa-propria.js';
import { createKommoClient, isLeadPaused } from '../services/kommo.service.js';
import { enviosDaSofia, mensagensOficiaisDaUnidade, type MensagemOficial } from '../services/kommo-talks.service.js';
import { carimbarHumanoAssumiu } from '../services/lead-metrics.service.js';

export const AUTOMACAO_PAUSA_EQUIPE = 'pausa-equipe';
/** Fala da equipe mais velha que isto não pausa (e não faz a ligação da chave varrer conversas antigas). */
export const JANELA_DA_EQUIPE_MS = 24 * 3600_000;
/**
 * Saudação e ausência do WhatsApp Business saem sozinhas, no mesmo instante da mensagem do paciente. Folga
 * para o eco chegar ao Kommo; para trás, tolerância de relógio entre a entrada e o eco.
 */
export const RESPOSTA_AUTOMATICA_MS = 20_000;
const RESPOSTA_AUTOMATICA_ANTES_MS = 5_000;
/** Resposta automática é texto pronto e longo; "Tenho sim." em 6 s é gente. */
export const RESPOSTA_AUTOMATICA_MIN_CARACTERES = 40;
const MENSAGENS_LIDAS = 40;

const APP_DO_CELULAR = 'whatsapp business';
/** Aviso do Kommo/WhatsApp que sai como mensagem de saída ("Unable to open this message…"). */
const AVISO_DO_SISTEMA = /^(unable to (open|display) this message|n[aã]o foi poss[ií]vel (abrir|exibir) (esta|essa) mensagem)/i;

type Recorder = { step(args: { kind: 'THINKING' | 'KOMMO_ACTION' | 'COMPLETED' | 'ERROR'; title: string; payload?: unknown }): Promise<void> };

export function estadoDaPausaPelaEquipe(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_PAUSA_EQUIPE, env.PAUSA_EQUIPE_SLUGS);
}

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

/**
 * PURA: a mensagem é a resposta automática do WhatsApp Business (saudação, ausência) ou aviso do sistema?
 * Visto em produção: Rio Verde, "⏰Nosso horário de atendimento é de segundas à sexta…" às 23:59, no mesmo
 * minuto da mensagem do paciente; Balsas, "Olá, tudo bem? 😄 Clínica Doutor Hérnia é especializada…".
 * Áudio e texto curto pelo celular são gente.
 */
export function ehRespostaAutomatica(m: MensagemOficial, msgs: readonly MensagemOficial[]): boolean {
  if (m.direcao !== 'saida') return false;
  const texto = m.texto.trim();
  if (AVISO_DO_SISTEMA.test(texto)) return true;
  if (m.autorNome.trim().toLowerCase() !== APP_DO_CELULAR) return false;
  if (m.anexo || texto.length < RESPOSTA_AUTOMATICA_MIN_CARACTERES) return false;
  const t = m.em.getTime();
  return msgs.some((p) => {
    if (p.direcao !== 'entrada') return false;
    const d = t - p.em.getTime();
    return d >= -RESPOSTA_AUTOMATICA_ANTES_MS && d <= RESPOSTA_AUTOMATICA_MS;
  });
}

/** PURA: o que a equipe escreveu de verdade (sem robô e sem resposta automática do app), em ordem. */
export function falasHumanasDaEquipe(msgs: readonly MensagemOficial[]): MensagemOficial[] {
  return msgs
    .filter((m) => m.direcao === 'saida' && m.autor === 'equipe' && !ehRespostaAutomatica(m, msgs))
    .sort((a, b) => a.em.getTime() - b.em.getTime());
}

/** PURA: a primeira fala humana da equipe depois de `desde` (ex.: depois do handoff), ou null. */
export function falaDaEquipeDepoisDe(msgs: readonly MensagemOficial[], desde: Date): MensagemOficial | null {
  return falasHumanasDaEquipe(msgs).find((m) => m.em.getTime() > desde.getTime()) ?? null;
}

export type SemPausa = 'sem_equipe' | 'antiga' | 'ia_falou_depois';
export type DecisaoDaEquipe = { fala: MensagemOficial; motivo: null } | { fala: null; motivo: SemPausa };

/**
 * PURA: a equipe tem a palavra? A última fala humana dela, se veio depois da última mensagem do agente e
 * nas últimas 24 h. (A checagem "desmarcaram a caixinha depois" pede o Kommo e fica em `conferirEquipe`.)
 */
export function equipeComAPalavra(
  msgs: readonly MensagemOficial[],
  ultimaFalaDaIa: Date | null,
  agora: Date,
): DecisaoDaEquipe {
  const falas = falasHumanasDaEquipe(msgs);
  const fala = falas[falas.length - 1];
  if (!fala) return { fala: null, motivo: 'sem_equipe' };
  if (agora.getTime() - fala.em.getTime() > JANELA_DA_EQUIPE_MS) return { fala: null, motivo: 'antiga' };
  if (ultimaFalaDaIa && ultimaFalaDaIa.getTime() >= fala.em.getTime()) return { fala: null, motivo: 'ia_falou_depois' };
  return { fala, motivo: null };
}

/** PURA: "Melissa às 10:25" / "o celular da clínica (WhatsApp Business) às 10:25". */
export function descreverFala(m: Pick<MensagemOficial, 'autorNome' | 'em'>, tz = 'America/Sao_Paulo'): string {
  const nome = m.autorNome.trim();
  const quem = !nome ? 'a equipe' : nome.toLowerCase() === APP_DO_CELULAR ? 'o celular da clínica (WhatsApp Business)' : nome;
  let hora: string;
  try {
    hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(m.em);
  } catch {
    hora = m.em.toISOString().slice(5, 16);
  }
  return `${quem} em ${hora}`;
}

// ── leitura e ação ──────────────────────────────────────────────────────────────────────────────

export type ResultadoDaPausa = 'marcou' | 'ja_estava' | 'sem_campo';

export interface DepsPausaEquipe {
  agora: () => Date;
  /** Conversa oficial do lead (todas as talks), com a sessão "Doutor Digital" já separada. Lança se não leu. */
  mensagens: (unit: Unit, leadId: number) => Promise<MensagemOficial[]>;
  /** Última mensagem que o agente mandou para o lead (qualquer unidade da mesma conta), ou null. */
  ultimaFalaDaIa: (unit: Unit, leadId: number, desde: Date) => Promise<Date | null>;
  /** Alguém mexeu na caixinha "Pausar IA" desde `desde`? Lança se não deu para perguntar. */
  pausaMexidaDesde: (unit: Unit, leadId: number, desde: Date) => Promise<boolean>;
  /** Marca "Pausar IA", carimba "assumido por humano" e cancela a reativação pendente. */
  marcarPausa: (unit: Unit, leadId: number) => Promise<ResultadoDaPausa>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

/** Unidades que dividem o cartão (comercial e resgate na mesma conta do Kommo). */
async function unidadesDaConta(unit: Pick<Unit, 'id' | 'kommoSubdomain'>): Promise<string[]> {
  if (!unit.kommoSubdomain) return [unit.id];
  const ids = (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id);
  return ids.length ? ids : [unit.id];
}

/** Gente assumiu: o handoff que a Sofia fez não deve mais ser reaberto pela reativação de 30 min. */
async function cancelarReativacao(unit: Unit, leadId: number): Promise<void> {
  try {
    await prisma.conversation.updateMany({
      where: { unitId: { in: await unidadesDaConta(unit) }, leadId: String(leadId), handoffAt: { not: null } },
      data: { handoffAt: null },
    });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não consegui cancelar a reativação (segue)');
  }
}

async function marcarPausaPadrao(unit: Unit, leadId: number): Promise<ResultadoDaPausa> {
  await cancelarReativacao(unit, leadId);
  if (!unit.kommoPausedFieldId) return 'sem_campo';
  const kommo = createKommoClient(unit);
  if (await kommo.isLeadFieldChecked(leadId, unit.kommoPausedFieldId)) return 'ja_estava';
  await kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, true);
  // Bloco DIGITAL: assumido por humano = Sim, status = Respondendo (o mesmo da auto-pausa antiga do webhook).
  void carimbarHumanoAssumiu(unit, kommo, leadId);
  return 'marcou';
}

export const DEPS_PAUSA_EQUIPE_PADRAO: DepsPausaEquipe = {
  agora: () => new Date(),
  mensagens: (unit, leadId) => mensagensOficiaisDaUnidade(unit, createKommoClient(unit), leadId, MENSAGENS_LIDAS),
  ultimaFalaDaIa: async (unit, leadId, desde) => (await enviosDaSofia(unit, leadId, desde))[0] ?? null,
  pausaMexidaDesde: async (unit, leadId, desde) =>
    unit.kommoPausedFieldId
      ? createKommoClient(unit).campoMudouDesde(leadId, unit.kommoPausedFieldId, Math.floor(desde.getTime() / 1000))
      : false,
  marcarPausa: marcarPausaPadrao,
  simular: registrarSimulacao,
};

export interface LeituraDaEquipe {
  msgs: MensagemOficial[];
  fala: MensagemOficial | null;
  motivo: SemPausa | 'devolvida' | 'nao_conferi' | null;
}

/**
 * Lê a conversa oficial (ou usa a já lida) e decide se a equipe tem a palavra. Lança só se não conseguiu
 * ler a conversa nem o banco — quem chama segue como antes (a Sofia responde).
 */
export async function conferirEquipe(
  unit: Unit,
  leadId: number,
  deps: DepsPausaEquipe = DEPS_PAUSA_EQUIPE_PADRAO,
  msgsJaLidas?: MensagemOficial[],
): Promise<LeituraDaEquipe> {
  const msgs = msgsJaLidas ?? (await deps.mensagens(unit, leadId));
  const agora = deps.agora();
  const ultimaIa = await deps.ultimaFalaDaIa(unit, leadId, new Date(agora.getTime() - JANELA_DA_EQUIPE_MS - 3600_000));
  const d = equipeComAPalavra(msgs, ultimaIa, agora);
  if (!d.fala) return { msgs, fala: null, motivo: d.motivo };
  // Desmarcaram (ou marcaram) "Pausar IA" depois da fala: alguém já decidiu depois dela — a fala não pausa
  // de novo. Sem resposta do Kommo, o lado seguro é o de antes: a Sofia responde.
  const mexida = await deps.pausaMexidaDesde(unit, leadId, d.fala.em).catch((err) => {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não consegui ler o histórico da caixinha (segue sem pausar)');
    return null;
  });
  if (mexida === null) return { msgs, fala: null, motivo: 'nao_conferi' };
  if (mexida) return { msgs, fala: null, motivo: 'devolvida' };
  return { msgs, fala: d.fala, motivo: null };
}

/**
 * A PORTA, antes de gerar a resposta. `pausou` = a Sofia não responde este turno. `msgs` volta para o
 * bloco <conversa_oficial> reaproveitar a leitura (null = não leu, o bloco lê sozinho).
 */
export async function portaDaEquipe(
  args: { unit: Unit; leadId: number; recorder?: Recorder },
  deps: DepsPausaEquipe = DEPS_PAUSA_EQUIPE_PADRAO,
): Promise<{ pausou: boolean; msgs: MensagemOficial[] | null }> {
  const { unit, leadId, recorder } = args;
  const estado = estadoDaPausaPelaEquipe(unit.slug);
  if (estado === 'desligado') return { pausou: false, msgs: null };
  let leitura: LeituraDaEquipe;
  try {
    leitura = await conferirEquipe(unit, leadId, deps);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não li a conversa oficial (segue sem pausar)');
    return { pausou: false, msgs: null };
  }
  if (!leitura.fala) return { pausou: false, msgs: leitura.msgs };
  const quem = descreverFala(leitura.fala, unit.spineTimezone ?? 'America/Sao_Paulo');

  if (estado === 'seco') {
    deps.simular(unit, AUTOMACAO_PAUSA_EQUIPE, {
      leadId,
      acao: 'gravaria',
      alvo: 'Pausar IA',
      valor: 'Sim',
      motivo: `a equipe falou com o paciente (${quem}) e a Sofia ia responder por cima`,
    });
    await recorder?.step({
      kind: 'THINKING',
      title: `📝 Só no papel: a equipe falou (${quem}) — com a chave ligada, a Sofia pausaria e não responderia`,
      payload: { leadId, fala: { em: leitura.fala.em, autor: leitura.fala.autorNome, texto: leitura.fala.texto.slice(0, 120) } },
    });
    return { pausou: false, msgs: leitura.msgs };
  }

  const resultado = await deps.marcarPausa(unit, leadId).catch((err) => {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: falha ao marcar "Pausar IA" (este turno fica calado mesmo assim)');
    return 'falhou' as const;
  });
  logger.info({ unit: unit.slug, leadId, resultado, autor: leitura.fala.autorNome }, 'IA auto-pausada: a equipe falou com o paciente (rota oficial)');
  await recorder?.step({
    kind: 'KOMMO_ACTION',
    title:
      resultado === 'marcou'
        ? `⏸ A equipe falou com o paciente (${quem}) — "Pausar IA" marcado, a Sofia não responde por cima`
        : `⏸ A equipe falou com o paciente (${quem}) — a Sofia não responde por cima (${resultado === 'sem_campo' ? 'unidade sem a caixinha "Pausar IA"' : resultado === 'ja_estava' ? '"Pausar IA" já estava marcado' : 'não consegui marcar "Pausar IA"'})`,
    payload: { leadId, resultado, fala: { em: leitura.fala.em, autor: leitura.fala.autorNome, texto: leitura.fala.texto.slice(0, 120) } },
  });
  return { pausou: true, msgs: leitura.msgs };
}

export interface DepsAntesDeEnviar extends DepsPausaEquipe {
  /** Pausa da unidade lida AGORA do banco (o objeto `unit` do turno é de antes do modelo pensar). */
  unidadeEmPausa: (unit: Unit) => Promise<boolean>;
  pausaComData: (unit: Unit, leadId: number) => Promise<boolean>;
  caixinhaMarcada: (unit: Unit, leadId: number) => Promise<boolean>;
  pausouSozinha: (leadId: number, desde: number) => boolean;
  anotar: (unit: Unit, leadId: number, texto: string) => Promise<void>;
}

export const DEPS_ANTES_DE_ENVIAR_PADRAO: DepsAntesDeEnviar = {
  ...DEPS_PAUSA_EQUIPE_PADRAO,
  unidadeEmPausa: async (unit) => {
    try {
      const u = await prisma.unit.findUnique({ where: { id: unit.id }, select: { pausaDesde: true, pausaAte: true } });
      return !!u && emPausa(u);
    } catch {
      return false;
    }
  },
  pausaComData: (unit, leadId) => leadPausadoPorJanela(unit.id, leadId),
  caixinhaMarcada: (unit, leadId) => isLeadPaused(unit, leadId),
  pausouSozinha: pausouSozinhaDesde,
  anotar: async (unit, leadId, texto) => {
    await createKommoClient(unit).addLeadNote(leadId, texto);
  },
};

/**
 * A TRAVA de antes de ENVIAR. O modelo leva em média ~20 s; nesse meio-tempo a equipe pode ter marcado
 * "Pausar IA", pausado pelo widget, a recepção pode ter pausado a unidade, ou a SDR pode ter escrito pelo
 * celular. Devolve o motivo para NÃO enviar (e já deixa nota no cartão com o texto que não saiu), ou null.
 *
 * Pausa que a própria Sofia fez neste turno (`pausar_ia`, teto de gasto) não trava: o aviso ao paciente
 * tem de sair. Falha em qualquer leitura = não trava (o comportamento de antes).
 */
export async function travaAntesDeEnviar(
  args: { unit: Unit; leadId: number; inicioDoTurno: number; resposta: string; marcouConsulta?: boolean; recorder?: Recorder },
  deps: DepsAntesDeEnviar = DEPS_ANTES_DE_ENVIAR_PADRAO,
): Promise<string | null> {
  const { unit, leadId, inicioDoTurno, resposta, recorder } = args;
  const propria = deps.pausouSozinha(leadId, inicioDoTurno);
  let motivo: string | null = null;

  if (!propria && (await deps.unidadeEmPausa(unit))) {
    motivo = 'a IA da unidade foi pausada enquanto a Sofia respondia';
  } else if (await deps.pausaComData(unit, leadId).catch(() => false)) {
    motivo = 'a Sofia foi pausada neste cartão (pausa com data) enquanto respondia';
  } else if (!propria && (await deps.caixinhaMarcada(unit, leadId).catch(() => false))) {
    motivo = '"Pausar IA" foi marcado no cartão enquanto a Sofia respondia';
  } else {
    const estado = estadoDaPausaPelaEquipe(unit.slug);
    if (estado !== 'desligado') {
      const leitura = await conferirEquipe(unit, leadId, deps).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não reli a conversa antes de enviar (segue)');
        return null;
      });
      const fala = leitura?.fala ?? null;
      if (fala) {
        const quem = descreverFala(fala, unit.spineTimezone ?? 'America/Sao_Paulo');
        if (estado === 'ligado') {
          const r = await deps.marcarPausa(unit, leadId).catch(() => 'falhou');
          logger.info({ unit: unit.slug, leadId, resultado: r }, 'IA auto-pausada antes de enviar: a equipe falou com o paciente (rota oficial)');
          motivo = `a equipe falou com o paciente (${quem}) enquanto a Sofia respondia`;
        } else if (fala.em.getTime() >= inicioDoTurno) {
          // seco: a fala de antes do turno já foi registrada na porta; aqui só a que chegou durante o turno
          deps.simular(unit, AUTOMACAO_PAUSA_EQUIPE, {
            leadId,
            acao: 'gravaria',
            alvo: 'Pausar IA',
            valor: 'Sim',
            motivo: `a equipe falou (${quem}) enquanto a Sofia pensava — a resposta seria descartada`,
          });
          await recorder?.step({
            kind: 'THINKING',
            title: `📝 Só no papel: a equipe falou (${quem}) enquanto a Sofia pensava — com a chave ligada, esta resposta seria descartada`,
            payload: { leadId, resposta },
          });
        }
      }
    }
  }

  if (!motivo) return null;
  logger.info({ unit: unit.slug, leadId, motivo }, 'resposta descartada: o cartão foi pausado enquanto a Sofia pensava');
  await recorder?.step({
    kind: 'THINKING',
    title: `⏸ Resposta descartada antes de enviar — ${motivo}`,
    payload: { leadId, motivo, resposta },
  });
  const nota =
    `⏸ A Sofia tinha uma resposta pronta e NÃO enviou: ${motivo}.` +
    (args.marcouConsulta ? ' ATENÇÃO: neste turno ela MARCOU consulta — confira a agenda antes de marcar de novo.' : '') +
    ` O que ela ia dizer: "${resposta.trim().slice(0, 300)}"`;
  await deps.anotar(unit, leadId, nota).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe: não consegui anotar a resposta descartada (segue)'),
  );
  return motivo;
}

/**
 * Para a REATIVAÇÃO de 30 min: a equipe falou com o paciente depois do handoff? (rota oficial, pega o
 * celular.) Não liga para a chave — reabrir a conversa no meio do atendimento humano é o que a reativação
 * nunca quis fazer. Falha na leitura = null (segue como antes; Parauapebas e Imperatriz recebem 403).
 */
export async function falaDaEquipeDesde(
  unit: Unit,
  leadId: number,
  desde: Date,
  deps: Pick<DepsPausaEquipe, 'mensagens'> = DEPS_PAUSA_EQUIPE_PADRAO,
): Promise<MensagemOficial | null> {
  try {
    return falaDaEquipeDepoisDe(await deps.mensagens(unit, leadId), desde);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'reativação: não li a conversa oficial (segue como antes)');
    return null;
  }
}
