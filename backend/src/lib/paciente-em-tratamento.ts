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
import { SpineService, SPINE_STATUS, type SpineClientDetail } from '../services/spine.service.js';
import { resumoDaAgenda } from './widget-agenda.js';
import { chaveDoTelefone, consultarIndice, type Entrada } from './franquia-indice-telefones.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { normalizarNome } from './kommo-schema.js';
import { logger } from './logger.js';
import { comTimeout } from './com-timeout.js';

export const ID_CALAR_PACIENTE = 'calar-paciente-em-tratamento';
/** Também é a `rule_key` do dedupe de 1 nota por dia por lead (`card_alert`). */
export const REGRA_NOTA_PACIENTE = 'paciente-em-tratamento';
export const REGRA_NOTA_INTERNO = 'numero-interno';
export const TIMEOUT_FRANQUIA_MS = 3000;

/** Status de tratamento na franquia: 44 pendente (fechado, ainda não começou) · 45 em andamento · 46 finalizado. */
const TRATAMENTO_ATIVO = new Set([44, 45]);
/** Decisão de 14/09: sem sessão futura, só é "em tratamento agora" quem fez sessão nos últimos 30 dias; o resto "parou no meio". */
export const DIAS_SEM_SESSAO = 30;
/** Janela da «avaliação recente» (corte de Timbó, 25/11): quem avaliou (ATENDIDO) há até 60 dias e escreve está na negociação, não é lead novo. */
export const DIAS_AVALIACAO_RECENTE = 60;
/** Avaliação que já passou e ainda está «de pé» (a recepção dá baixa dias depois): só conta por 7 dias — um lead que faltou e ninguém deu
 *  baixa não pode calar a Sofia por 2 meses. Falta e desmarcado nunca contam. */
export const DIAS_AVALIACAO_SEM_BAIXA = 7;
const AVALIACAO_SEM_BAIXA: ReadonlySet<number> = new Set([SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO]);

export function calarPacienteEstado(slug: string, raw: string | undefined = process.env.CALAR_PACIENTE_EM_TRATAMENTO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_CALAR_PACIENTE, raw);
}

export type SinalDaFranquia =
  | {
      tipo: 'paciente';
      idClient: number;
      tratamentoAtivo: boolean;
      sessaoFutura: boolean;
      /** avaliação/retorno ATENDIDO nos últimos `DIAS_AVALIACAO_RECENTE` dias, ou passado e ainda sem baixa nos últimos `DIAS_AVALIACAO_SEM_BAIXA`
       *  (falta e desmarcado não contam; olha TODAS as consultas passadas, não só a última). Só a unidade que
       *  saiu da Kommo usa (kommo-cortado.ts): lá não há o cartão em COMPARECEU/NEGOCIAÇÃO que segurava a Sofia. */
      avaliacaoRecente?: boolean;
    }
  /** o telefone só existe como LEAD na franquia */
  | { tipo: 'lead' }
  | { tipo: 'nao_achou' }
  /** índice ilegível, ficha fora do ar, timeout, telefone ilegível */
  | { tipo: 'indisponivel'; motivo: string };

export type Decisao =
  | { calar: false; motivo: 'segue' | 'ja_tem_idclient' | 'fora_do_comercial' | 'franquia_sem_resposta' }
  | { calar: true; motivo: 'numero_interno' | 'paciente_em_tratamento' | 'nao_paciente'; detalhe: string };

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
  // TODAS as avaliações/retornos passados (não só a última): avaliou há 20 dias e faltou ao retorno há 3 continua sendo quem avaliou
  const dia = 86_400_000;
  const avaliacaoRecente = agenda.consultas.some((c) => {
    const quando = c.quando ? Date.parse(c.quando) : NaN;
    if (c.futura || !Number.isFinite(quando) || c.idStatus === null) return false;
    const idade = agora.getTime() - quando;
    if (idade < 0) return false;
    if (c.idStatus === SPINE_STATUS.ATENDIDO) return idade <= DIAS_AVALIACAO_RECENTE * dia;
    return AVALIACAO_SEM_BAIXA.has(c.idStatus) && idade <= DIAS_AVALIACAO_SEM_BAIXA * dia;
  });
  return { tipo: 'paciente', idClient, tratamentoAtivo, sessaoFutura, avaliacaoRecente };
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
      const resposta = await lerIndice(unit.id, chave);
      const ind = entradaDoIndice(resposta.entradas);
      if (ind.tipo !== 'paciente') {
        // «não achei» / «só lead» só vale com o índice FRESCO: vazio (nunca carregado) ou vencido (> 36 h) não prova que o telefone não é de paciente.
        // Quem chama decide o que fazer com «indisponivel» (a Sofia responde como sempre; a reabertura de PERDIDO deixa o cartão onde está).
        if (!resposta.fresco) return { tipo: 'indisponivel', motivo: resposta.idadeHoras == null ? 'índice de telefones da franquia ainda não carregado' : `índice de telefones vencido (${resposta.idadeHoras} h)` };
        return ind;
      }
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

/** Telefone marcado como NÃO-PACIENTE pela equipe (automação nao-paciente-manual): motivo e caminho de desfazer próprios. */
export const REGRA_NOTA_NAO_PACIENTE = 'nao-paciente-telefone';
export function notaNaoPaciente(mensagem: string): string {
  const t = mensagem.replace(/\s+/g, ' ').trim();
  return (
    `🤫 Este telefone foi marcado como NÃO-PACIENTE (funcionário/currículo) num cartão desta unidade — a Sofia não responde.` +
    `${t ? ` Disse: "${t.slice(0, 140)}${t.length > 140 ? '…' : ''}"` : ''} Se for paciente, avise a Doutor Digital para desmarcar.`
  );
}

export function notaNumeroInterno(mensagem: string): string {
  const t = mensagem.replace(/\s+/g, ' ').trim();
  return `🤫 Número interno da rede — a Sofia não responde.${t ? ` Disse: "${t.slice(0, 140)}${t.length > 140 ? '…' : ''}"` : ''}`;
}
