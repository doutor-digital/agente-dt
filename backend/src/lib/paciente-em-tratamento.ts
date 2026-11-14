/**
 * Paciente EM TRATAMENTO que escreve num cartão NOVO e vazio (incidente de 14/11/2026, Petrópolis e Caxias).
 *
 * O paciente responde "Confirmado" / "🙏" / "Ok" ao lembrete de sessão. No WhatsApp Lite o Kommo cria um cartão novo
 * ("Lead 23 14/11/2026", funil COMERCIAL) e a Sofia, sem saber quem é, responde como a lead nova ("como posso te chamar?").
 * Só ~30 min depois o sincronizador da franquia casa o telefone e leva o cartão para TRATAMENTO. Frase nenhuma denuncia
 * o paciente ("Confirmado" não diz nada), então a pergunta é feita ANTES de a Sofia gerar a resposta: este telefone é de
 * paciente com tratamento ativo ou sessão futura na franquia?
 *
 * De onde vem a resposta: do índice de telefones da franquia (`franquia-indice-telefones.ts`, no nosso banco — a franquia
 * ignora filtro de telefone e o nome do cartão é "Lead 23", inútil para buscar). O índice diz SE o telefone é paciente ou
 * lead e o idClient; a ficha do paciente (`getClient`, timeout curto) diz se há tratamento ativo ou sessão futura.
 *
 * Lado seguro, sempre:
 *  - franquia fora do ar / índice sem resposta / ficha lenta → comportamento de hoje (a Sofia responde), com log;
 *  - paciente SEM tratamento ativo e SEM sessão futura (só fez avaliação, ou já terminou) → a Sofia responde como hoje;
 *  - lead da franquia → responde (é o caminho normal do lead novo).
 * O índice guarda UM cadastro por telefone e origem: mãe e filha no mesmo WhatsApp não aparecem como "ambíguo" aqui.
 * Quando o cadastro achado tem tratamento ativo, a Sofia cala — o erro vai para o lado de a equipe responder.
 *
 * Número INTERNO (`NUMEROS_INTERNOS`) também cala: hoje a lista só barra o cadastro na franquia.
 */
import { SpineService, type SpineClientDetail } from '../services/spine.service.js';
import { resumoDaAgenda } from './widget-agenda.js';
import { chaveDoTelefone, consultarIndice, type Entrada } from './franquia-indice-telefones.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { normalizarNome } from './kommo-schema.js';
import { logger } from './logger.js';

export const ID_CALAR_PACIENTE = 'calar-paciente-em-tratamento';
/** Também é a `rule_key` do dedupe de 1 nota por dia por lead (`card_alert`). */
export const REGRA_NOTA_PACIENTE = 'paciente-em-tratamento';
export const REGRA_NOTA_INTERNO = 'numero-interno';
export const TIMEOUT_FRANQUIA_MS = 3000;

/** Status de tratamento na franquia: 44 pendente (fechado, ainda não começou) · 45 em andamento · 46 finalizado. */
const TRATAMENTO_ATIVO = new Set([44, 45]);
/** Decisão de 14/09: sem sessão futura, só é "em tratamento agora" quem fez sessão nos últimos 30 dias; o resto "parou no meio". */
export const DIAS_SEM_SESSAO = 30;

export function calarPacienteEstado(slug: string, raw: string | undefined = process.env.CALAR_PACIENTE_EM_TRATAMENTO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_CALAR_PACIENTE, raw);
}

export type SinalDaFranquia =
  | { tipo: 'paciente'; idClient: number; tratamentoAtivo: boolean; sessaoFutura: boolean }
  /** o telefone só existe como LEAD na franquia */
  | { tipo: 'lead' }
  | { tipo: 'nao_achou' }
  /** índice ilegível, ficha fora do ar, timeout, telefone ilegível */
  | { tipo: 'indisponivel'; motivo: string };

export type Decisao =
  | { calar: false; motivo: 'segue' | 'ja_tem_idclient' | 'fora_do_comercial' | 'franquia_sem_resposta' }
  | { calar: true; motivo: 'numero_interno' | 'paciente_em_tratamento'; detalhe: string };

export interface EntradaDaDecisao {
  interno: boolean;
  /** o cartão já tem o vínculo com a franquia (spine_lead_links): é caso do sincronizador, vale a regra de hoje */
  temIdClient: boolean;
  /** nome do funil do cartão */
  funil: string | null | undefined;
  /** só é lido quando precisa (o chamador não consulta a franquia à toa) */
  sinal: SinalDaFranquia | null;
}

/** O cartão está no funil COMERCIAL (onde nasce o cartão vazio)? */
export function ehFunilComercial(funil: string | null | undefined): boolean {
  return normalizarNome(funil ?? '').includes('comercial');
}

/**
 * Puro: a porta roda neste turno? Só em mensagem de chat com texto, e NUNCA em turno aberto pela Ponte ("Passar para a
 * Sofia"): foi a própria equipe que mandou a Sofia falar — calar ali contraria a ordem da menina (mesma regra da pausa-equipe).
 */
export function portaRodaNoTurno(t: { isChatMessage: boolean; humanMessage: string; passadoPelaPonte: boolean }): boolean {
  return t.isChatMessage && t.humanMessage.trim().length > 0 && !t.passadoPelaPonte;
}

/** Puro. Quando a decisão precisa da franquia: interno decide sozinho; cartão sem idClient no COMERCIAL consulta. */
export function precisaConsultarFranquia(e: Pick<EntradaDaDecisao, 'interno' | 'temIdClient' | 'funil'>): boolean {
  return !e.interno && !e.temIdClient && ehFunilComercial(e.funil);
}

/** Puro: a Sofia cala? */
export function decidir(e: EntradaDaDecisao): Decisao {
  if (e.interno) return { calar: true, motivo: 'numero_interno', detalhe: 'telefone em NUMEROS_INTERNOS' };
  if (e.temIdClient) return { calar: false, motivo: 'ja_tem_idclient' };
  if (!ehFunilComercial(e.funil)) return { calar: false, motivo: 'fora_do_comercial' };
  const s = e.sinal;
  if (!s || s.tipo === 'indisponivel') return { calar: false, motivo: 'franquia_sem_resposta' };
  if (s.tipo === 'paciente' && (s.tratamentoAtivo || s.sessaoFutura)) {
    const por = [s.tratamentoAtivo ? 'tratamento ativo' : '', s.sessaoFutura ? 'sessão futura' : ''].filter(Boolean).join(' + ');
    return { calar: true, motivo: 'paciente_em_tratamento', detalhe: `paciente da franquia (idClient ${s.idClient}) com ${por}` };
  }
  return { calar: false, motivo: 'segue' };
}

/** Puro: a ficha do paciente → tratamento ativo e/ou sessão futura (que não é avaliação nem consulta). */
export function sinalDaFicha(idClient: number, ficha: Pick<SpineClientDetail, 'schedules' | 'treatments'>, agora: Date = new Date()): SinalDaFranquia {
  const agenda = resumoDaAgenda(ficha.schedules, agora);
  const ultima = agenda.ultimaSessao?.quando ? Date.parse(agenda.ultimaSessao.quando) : NaN;
  // status 45 na franquia não basta: quem abandonou o tratamento há meses continua "em andamento" lá e é lead que volta
  const recente = Number.isFinite(ultima) && agora.getTime() - ultima <= DIAS_SEM_SESSAO * 86_400_000;
  const tratamentoAtivo = recente && ficha.treatments.some((t) => t.idStatus !== null && TRATAMENTO_ATIVO.has(t.idStatus));
  const sessaoFutura = !!agenda.proximaSessao;
  return { tipo: 'paciente', idClient, tratamentoAtivo, sessaoFutura };
}

/** Puro: o que o índice diz do telefone. Paciente vence lead; sem entrada com id utilizável não se afirma nada. */
export function entradaDoIndice(entradas: ReadonlyArray<Pick<Entrada, 'origem' | 'id'>>): { tipo: 'paciente'; idClient: number } | { tipo: 'lead' } | { tipo: 'nao_achou' } | { tipo: 'indisponivel'; motivo: string } {
  const pac = entradas.filter((e) => e.origem === 'paciente');
  if (pac.length) {
    const id = pac.find((e) => e.id)?.id;
    return id ? { tipo: 'paciente', idClient: id } : { tipo: 'indisponivel', motivo: 'paciente no índice sem id' };
  }
  return entradas.length ? { tipo: 'lead' } : { tipo: 'nao_achou' };
}

export interface DepsDaConsulta {
  indice?: typeof consultarIndice;
  ficha?: (idClient: number) => Promise<Pick<SpineClientDetail, 'schedules' | 'treatments'> | null>;
  agora?: () => Date;
}

function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout de ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Pergunta à franquia (índice local + ficha), com teto de `TIMEOUT_FRANQUIA_MS` NO TOTAL. Nunca lança: qualquer falha
 * vira `indisponivel` e a Sofia responde como sempre.
 */
export async function consultarFranquia(
  unit: Parameters<typeof SpineService.getClient>[0] & { id: string; slug: string; spineEnabled?: boolean | null; spineToken?: string | null },
  telefone: string | null | undefined,
  deps: DepsDaConsulta = {},
): Promise<SinalDaFranquia> {
  if (!unit.spineEnabled || !unit.spineToken) return { tipo: 'indisponivel', motivo: 'unidade sem franquia conectada' };
  const chave = chaveDoTelefone(telefone);
  if (!chave) return { tipo: 'indisponivel', motivo: 'telefone ilegível' };
  const lerIndice = deps.indice ?? consultarIndice;
  const lerFicha = deps.ficha ?? (async (id: number) => {
    const r = await SpineService.getClient(unit, id);
    return r.ok ? (r.data?.client ?? null) : null;
  });
  try {
    return await comTimeout((async (): Promise<SinalDaFranquia> => {
      const ind = entradaDoIndice((await lerIndice(unit.id, chave)).entradas);
      if (ind.tipo !== 'paciente') return ind;
      const ficha = await lerFicha(ind.idClient);
      if (!ficha) return { tipo: 'indisponivel', motivo: 'ficha do paciente não veio' };
      return sinalDaFicha(ind.idClient, ficha, (deps.agora ?? (() => new Date()))());
    })(), TIMEOUT_FRANQUIA_MS);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'paciente-em-tratamento: franquia sem resposta — a Sofia responde como sempre');
    return { tipo: 'indisponivel', motivo: String(err) };
  }
}

/** A nota que fica no cartão. Curta: a equipe lê no celular. */
export function notaPacienteEmTratamento(mensagem: string): string {
  const t = mensagem.replace(/\s+/g, ' ').trim();
  return `🤫 Paciente em tratamento na franquia — a equipe responde.${t ? ` Disse: "${t.slice(0, 140)}${t.length > 140 ? '…' : ''}"` : ''}`;
}

export function notaNumeroInterno(mensagem: string): string {
  const t = mensagem.replace(/\s+/g, ' ').trim();
  return `🤫 Número interno da rede — a Sofia não responde.${t ? ` Disse: "${t.slice(0, 140)}${t.length > 140 ? '…' : ''}"` : ''}`;
}
