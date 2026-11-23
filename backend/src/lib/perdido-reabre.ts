/**
 * O paciente RESPONDE num cartão em PERDIDO: o cartão volta para EM QUALIFICAÇÃO e a Sofia assume (decisão do João, 23/11/2026).
 *
 * O caso (Timbó, lead 6624948, Jairo): cartão em PERDIDO (143 do COMERCIAL); o robô de reativação do Kommo mandou, 22/11 08:28,
 * "Quer que eu veja os horários desta semana?" com botões e o texto de encerramento "responda esta mensagem que eu reabro o seu
 * cadastro". O paciente tocou "Ver horários" às 08:38; o webhook caiu em `__stage_not_allowed__` (PERDIDO não está na lista de etapas
 * da unidade) e ninguém respondeu por 11 h — o robô prometeu o que o código não fazia. Desde então ele escreveu mais 6 vezes.
 *
 * O QUE FAZ (chave `perdido-responde-reabre`, por unidade, desligada por padrão; "só no papel" decide e registra sem tocar no Kommo):
 *  - SÓ roda onde o turno já ia ser pulado por etapa fora da lista da unidade (`__stage_not_allowed__`) e o cartão está em PERDIDO do
 *    funil COMERCIAL (o 143 do TRATAMENTO é TRATAMENTO CANCELADO e nunca reabre). Unidade que já deixa a Sofia falar em PERDIDO não passa por aqui.
 *  - move o cartão para EM QUALIFICAÇÃO do MESMO funil (achada pelo NOME no esquema da conta, nunca por id fixo) e o turno SEGUE: a
 *    Sofia responde a esta mesma mensagem (ao "Ver horários"). Se EM QUALIFICAÇÃO não estiver na lista de etapas da unidade, não move —
 *    senão o cartão andaria e a Sofia continuaria muda.
 *  - deixa uma nota no cartão e guarda uma marca de 24 h: é um freio ANTI-VAIVÉM, não uma trava de decisão humana. Se alguém (equipe, robô do
 *    Kommo, perda-ia) fechar o cartão de novo logo depois, a próxima fala não o reabre e não empilha nota em cima de nota; passado 1 dia, o
 *    paciente que responde reabre outra vez. (Não dá para saber QUEM fechou sem ler o histórico de eventos do Kommo; 7 dias travaria o paciente
 *    que volta por causa de um robô.) Quem fecha por não ser lead (etiqueta, motivo encerrado) já é barrado pelas regras abaixo.
 *
 * QUEM É "O PACIENTE": o webhook só abre turno para mensagem que CHEGA (`incoming`); a fala da equipe e do robô/Salesbot saem como
 * `outgoing` e nunca chegam aqui. O toque num botão do robô ("Ver horários") entra como mensagem de texto do paciente e CONTA — foi
 * exatamente o caso do Jairo. Não contam: cortesia pura ("ok, obrigado"), pedido para parar ("sair"), mensagem sem conteúdo e turno
 * retomado depois de um deploy (um pedido de minutos atrás: mexer na ETAPA agora é agir sobre uma conversa que já seguiu).
 *
 * QUANDO NÃO REABRE (não é lead, ou já tem gente com ele) — o cartão fica em PERDIDO, a Sofia continua calada e o motivo vai para o trace:
 *  - etiqueta de não contatar (NO_FOLLOW_UP, NAO_PERTURBAR, BLOQUEADO_WHATSAPP, opt-out, CURRÍCULO, Fora do escopo) ou ✓ Opt-out WhatsApp;
 *  - motivo de perda ENCERRADO (Outra cidade, Clicou por engano, Outra patologia, Plano de Saúde, Sem interesse, Bandeira vermelha…) nos
 *    campos ⊘ ou no diálogo nativo do Kommo — o MESMO critério da régua de reativação (`porQueNaoTocar`): quem ela nunca procura, a Sofia
 *    também não reabre;
 *  - «Pausar IA» marcado, ◷ Retomar em de hoje em diante, consulta futura no cartão (alguém decidiu por este cartão);
 *  - a EQUIPE FALOU com o paciente (o mesmo critério da `pausa-equipe`, com a mesma janela e o mesmo Lite), ou a conversa não pôde ser lida;
 *  - o telefone é de PACIENTE da franquia com tratamento ativo ou sessão futura (o mesmo critério do `calar-paciente-em-tratamento`) ou
 *    foi marcado como não-paciente pela equipe. A franquia que não responde NÃO é «tudo bem»: o cartão fica (o erro caro é reabrir quem está em
 *    tratamento; o barato é a equipe responder um paciente a mais);
 *  - conta do Kommo dividida entre unidades (Petrópolis/Caxias): fora desta versão.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { createKommoClient } from '../services/kommo.service.js';
import { invalidarEtapa } from '../services/lead-stage.service.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { esquemaDaUnidade, normalizarNome, type EsquemaKommo } from './kommo-schema.js';
import { etapaPermitida, type FunisDaConta } from './etapa-permitida.js';
import { ETAPA } from './franquia-move.js';
import { ehRespostaDeCortesia } from './cortesia.js';
import { porQueNaoTocar, type MotivosNativos } from './rotina-nucleo.js';
import { contatoPrincipal } from './kommo-lead-util.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { registrarSimulacao } from './so-no-papel.js';
import { grupoDaUnidade } from './crm-compartilhado.js';
import { conferirEquipe, descreverFala, type LeituraDaEquipe } from './pausa-equipe.js';
import { consultarFranquia, ehFunilComercial, type SinalDaFranquia } from './paciente-em-tratamento.js';
import { telefoneMarcadoNaoPaciente } from './nao-paciente-manual.js';
import { agendarIndice } from './franquia-indice-telefones.js';

export const ID_PERDIDO_REABRE = 'perdido-responde-reabre';
/** `rule_key` da marca em `card_alert`: o cartão já foi reaberto por aqui. */
export const REGRA_PERDIDO_REABERTO = 'perdido-reaberto';
/** Freio anti-vaivém: reaberto e fechado de novo, dentro desta janela o cartão fica em PERDIDO. Falha de leitura do banco = sem freio (o aviso-dedupe falha aberto). */
export const JANELA_DA_REABERTURA_MS = 24 * 3600_000;
/** O 143 do Kommo: PERDIDO no COMERCIAL (e TRATAMENTO CANCELADO no TRATAMENTO — o nome do funil separa os dois). */
const STATUS_PERDIDO = 143;

export function perdidoReabreEstado(slug: string, raw: string | undefined = process.env.PERDIDO_REABRE_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_PERDIDO_REABRE, raw);
}

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

/**
 * "SAIR" / "parar" / "não quero mais receber": o paciente pede para NÃO ser procurado — reabrir seria o contrário. A palavra solta só vale
 * SOZINHA ("Parar de tomar o remédio piora?" e "Sair de casa dói, quero marcar" são pacientes); a frase de descadastro vale em qualquer lugar.
 */
const PALAVRA_DE_SAIR = /^[\s.!?¡]*(sair|parar|pare|stop|descadastrar)[\s.!?]*$/i;
const FRASE_DE_SAIR = /\b(n[aã]o quero (mais )?(receber|mensagens?)|(pare|parar) de (me )?(mandar|enviar)|me (tire|tira|remov[ae])\b.*\blista|cancelar (a )?inscri[cç][aã]o|descadastr)/i;
export function pedeParaSair(texto: string): boolean {
  const t = texto.normalize('NFC').trim();
  return PALAVRA_DE_SAIR.test(t) || FRASE_DE_SAIR.test(t);
}

/** O que o Whisper devolve quando o áudio não tem fala: não é o paciente respondendo. */
const AUDIO_SEM_FALA = /^\s*\[áudio sem fala detectada\]\s*$/i;

/** O cartão está em PERDIDO do funil COMERCIAL (e não no 143 do TRATAMENTO)? Pelo NOME, no esquema da conta. */
export function ehPerdidoDoComercial(
  esquema: Pick<EsquemaKommo, 'nomeDoStatus'>,
  pipelineId: number | null | undefined,
  statusId: number | null | undefined,
): { ok: true; funil: string } | { ok: false } {
  if (!pipelineId || statusId !== STATUS_PERDIDO) return { ok: false };
  const posicao = esquema.nomeDoStatus(pipelineId, statusId);
  if (!posicao || normalizarNome(posicao.status) !== 'perdido' || !ehFunilComercial(posicao.pipeline)) return { ok: false };
  return { ok: true, funil: posicao.pipeline };
}

/** A franquia diz que este telefone é de paciente que está em tratamento (ou tem sessão marcada)? */
export function pacienteEmTratamentoNaFranquia(s: SinalDaFranquia | null): string | null {
  if (!s || s.tipo !== 'paciente' || !(s.tratamentoAtivo || s.sessaoFutura)) return null;
  const por = [s.tratamentoAtivo ? 'tratamento ativo' : '', s.sessaoFutura ? 'sessão futura' : ''].filter(Boolean).join(' + ');
  return `paciente da franquia (idClient ${s.idClient}) com ${por}`;
}

/** A nota que fica no cartão. Curta: a equipe lê no celular. */
export function notaCartaoReaberto(mensagem: string, motivoDaPerda: string | null): string {
  const t = mensagem.replace(/\s+/g, ' ').trim();
  return (
    '↩ Cartão reaberto: o paciente respondeu em PERDIDO. Voltou para EM QUALIFICAÇÃO e a Sofia atende.' +
    `${motivoDaPerda ? ` Motivo da perda: ${motivoDaPerda}.` : ''}` +
    `${t ? ` Disse: "${t.slice(0, 140)}${t.length > 140 ? '…' : ''}"` : ''}`
  );
}

// ── a porta ─────────────────────────────────────────────────────────────────────────────────────

export type MotivoDeNaoReabrir =
  | 'conta_dividida'
  | 'turno_retomado'
  | 'sem_conteudo'
  | 'cortesia'
  | 'pediu_para_sair'
  | 'esquema_ilegivel'
  | 'sem_etapa_de_qualificacao'
  | 'qualificacao_fora_da_lista'
  | 'ja_reaberto_recentemente'
  | 'cartao'
  | 'motivos_de_perda_ilegiveis'
  | 'equipe_falou'
  | 'equipe_nao_lida'
  | 'nao_paciente_marcado'
  | 'telefone_ilegivel'
  | 'paciente_em_tratamento'
  | 'franquia_sem_resposta'
  | 'erro';

export interface ResultadoDaReabertura {
  estado: 'ligado' | 'seco';
  /** o cartão FOI movido (só no estado ligado): o turno segue e a Sofia responde */
  reabriu: boolean;
  /** a decisão (no seco, `reabrir` e `reabriu: false`) */
  decisao: 'reabrir' | 'nao_reabrir';
  motivo: 'reabrir' | 'falha_ao_mover' | MotivoDeNaoReabrir;
  detalhe?: string;
  /** a etapa para onde foi (ou iria) */
  para?: { statusId: number; pipelineId: number; nome: string };
}

export interface DepsDaReabertura {
  estado: (slug: string) => Estado;
  esquema: (unit: Unit, kommo: KommoClient) => Promise<EsquemaKommo>;
  contaDividida: (unitId: string) => Promise<boolean>;
  reabertoRecentemente: (unitId: string, leadId: number) => Promise<boolean>;
  marcarReaberto: (unitId: string, leadId: number) => Promise<void>;
  motivosNativos: (unit: Unit, kommo: KommoClient) => Promise<MotivosNativos | null>;
  equipe: (unit: Unit, leadId: number) => Promise<LeituraDaEquipe>;
  telefone: (kommo: KommoClient, lead: KommoLead, contactId: string | null) => Promise<string | null>;
  naoPacienteMarcado: (unit: Unit, telefone: string) => Promise<boolean>;
  franquia: (unit: Unit, telefone: string) => Promise<SinalDaFranquia>;
  simular: typeof registrarSimulacao;
  agora: () => Date;
}

const MOTIVOS_TTL_MS = 60 * 60_000;
const motivosCache = new Map<string, { em: number; mapa: MotivosNativos }>();

async function motivosNativosDaConta(unit: Unit, kommo: KommoClient): Promise<MotivosNativos | null> {
  const hit = motivosCache.get(unit.id);
  if (hit && Date.now() - hit.em < MOTIVOS_TTL_MS) return hit.mapa;
  try {
    const mapa: MotivosNativos = new Map((await kommo.listLossReasons()).map((m) => [m.id, m.name]));
    motivosCache.set(unit.id, { em: Date.now(), mapa });
    return mapa;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'perdido-reabre: não li os motivos de perda da conta (o cartão com motivo nativo fica)');
    return null;
  }
}

export const DEPS_DA_REABERTURA: DepsDaReabertura = {
  estado: perdidoReabreEstado,
  esquema: esquemaDaUnidade,
  contaDividida: async (unitId) => !!(await grupoDaUnidade(unitId)),
  reabertoRecentemente: (unitId, leadId) => avisoRecente(unitId, leadId, REGRA_PERDIDO_REABERTO, JANELA_DA_REABERTURA_MS),
  marcarReaberto: (unitId, leadId) => marcarAviso(unitId, leadId, REGRA_PERDIDO_REABERTO),
  motivosNativos: motivosNativosDaConta,
  equipe: (unit, leadId) => conferirEquipe(unit, leadId),
  telefone: async (kommo, lead, contactId) => {
    const id = contactId && Number.isFinite(Number(contactId)) ? Number(contactId) : contatoPrincipal(lead);
    return id ? kommo.getContactPhone(id).catch(() => null) : null;
  },
  naoPacienteMarcado: (unit, telefone) => telefoneMarcadoNaoPaciente(unit, telefone),
  franquia: async (unit, telefone) => {
    // o índice de telefones precisa existir para a pergunta ter resposta; é idempotente (1 carga por dia)
    agendarIndice(unit);
    return consultarFranquia(unit, telefone);
  },
  simular: registrarSimulacao,
  agora: () => new Date(),
};

export interface PedidoDeReabertura {
  unit: Unit;
  leadId: number;
  /** o cartão como o webhook acabou de ler (status, funil, etiquetas, campos) */
  lead: KommoLead;
  /** a fala do paciente já com o áudio transcrito (como a Sofia a recebe) */
  humanMessage: string;
  contactId: string | null;
  isChatMessage: boolean;
  /** turno refeito depois de um deploy: não mexe na etapa */
  retomada: boolean;
  /** as etapas que a unidade deixa a Sofia atender (`kommoAllowedStatusIds`) e os funis da conta, se lidos */
  allowedStatusIds: readonly number[];
  funis: FunisDaConta | null;
  kommo?: KommoClient;
}

const nao = (estado: 'ligado' | 'seco', motivo: MotivoDeNaoReabrir, detalhe?: string): ResultadoDaReabertura => ({
  estado,
  reabriu: false,
  decisao: 'nao_reabrir',
  motivo,
  ...(detalhe ? { detalhe } : {}),
});

/**
 * `null` = nada a fazer: chave desligada, ou o cartão não está em PERDIDO (143) — não lê nem escreve nada. Nunca lança: qualquer falha
 * vira "não reabriu" e o turno segue como sempre foi (pulado por etapa).
 */
export async function portaPerdidoReabre(p: PedidoDeReabertura, deps: DepsDaReabertura = DEPS_DA_REABERTURA): Promise<ResultadoDaReabertura | null> {
  const { unit, leadId, lead } = p;
  const estado = deps.estado(unit.slug);
  if (estado === 'desligado') return null;
  if (lead.status_id !== STATUS_PERDIDO) return null;
  try {
    const kommo = p.kommo ?? createKommoClient(unit);
    const esquema = await deps.esquema(unit, kommo);
    const perdido = ehPerdidoDoComercial(esquema, lead.pipeline_id, lead.status_id);
    if (!perdido.ok) return null; // o 143 do TRATAMENTO (TRATAMENTO CANCELADO) ou funil que não se reconhece
    const funil = esquema.nomeDoFunil(lead.pipeline_id) ?? perdido.funil;

    // 1. o que se sabe sem chamar ninguém
    if (!p.isChatMessage) return nao(estado, 'sem_conteudo', 'não é mensagem de chat');
    if (p.retomada) return nao(estado, 'turno_retomado', 'turno refeito depois de um deploy: a etapa não se mexe');
    const texto = p.humanMessage.trim();
    if (!texto || AUDIO_SEM_FALA.test(texto)) return nao(estado, 'sem_conteudo');
    if (pedeParaSair(texto)) return nao(estado, 'pediu_para_sair');
    if (ehRespostaDeCortesia(texto)) return nao(estado, 'cortesia');
    if (await deps.contaDividida(unit.id)) return nao(estado, 'conta_dividida');

    // 2. para onde vai: EM QUALIFICAÇÃO do mesmo funil, pelo nome — e a Sofia tem de poder falar lá
    const idQualificacao = esquema.statusPorNome(funil, ETAPA.QUALIFICACAO);
    if (!idQualificacao) return nao(estado, 'sem_etapa_de_qualificacao', `o funil ${funil} não tem a etapa ${ETAPA.QUALIFICACAO}`);
    if (!etapaPermitida(p.allowedStatusIds, idQualificacao, lead.pipeline_id, p.funis)) {
      return nao(estado, 'qualificacao_fora_da_lista', `${ETAPA.QUALIFICACAO} (${idQualificacao}) não está nas etapas em que a Sofia atende nesta unidade`);
    }
    const para = { statusId: idQualificacao, pipelineId: lead.pipeline_id, nome: ETAPA.QUALIFICACAO };
    if (await deps.reabertoRecentemente(unit.id, leadId)) return nao(estado, 'ja_reaberto_recentemente', 'o cartão já foi reaberto por aqui nas últimas 24 h e fechado de novo: fica (anti-vaivém)');

    // 3. o que o CARTÃO diz (de graça): etiquetas de não contatar, motivo encerrado, Pausar IA, Retomar em, consulta futura
    const nativos = lead.loss_reason_id ? await deps.motivosNativos(unit, kommo) : null;
    const razao = porQueNaoTocar(lead, {
      agora: Math.floor(deps.agora().getTime() / 1000),
      tz: unit.spineTimezone ?? 'America/Sao_Paulo',
      pausarIaFieldId: unit.kommoPausedFieldId ?? null,
      conferirMotivoMorto: true,
      motivosNativos: nativos,
    });
    if (razao) return nao(estado, razao.codigo === 'motivo-nativo-desconhecido' ? 'motivos_de_perda_ilegiveis' : 'cartao', `${razao.codigo}: ${razao.texto}`);

    // 4. o telefone: sem ele não se afirma nada, e o que é só banco local vem antes do que lê a conversa
    const telefone = await deps.telefone(kommo, lead, p.contactId);
    if (!telefone) return nao(estado, 'telefone_ilegivel');
    if (await deps.naoPacienteMarcado(unit, telefone)) return nao(estado, 'nao_paciente_marcado', 'telefone marcado como não-paciente nesta unidade');

    // 5. a EQUIPE está com o paciente? (as mesmas regras da pausa-equipe, mesmo com a chave dela desligada)
    let leitura: LeituraDaEquipe;
    try {
      leitura = await deps.equipe(unit, leadId);
    } catch (err) {
      return nao(estado, 'equipe_nao_lida', `não li a conversa oficial: ${String(err).slice(0, 120)}`);
    }
    if (leitura.fala) return nao(estado, 'equipe_falou', descreverFala(leitura.fala, unit.spineTimezone ?? 'America/Sao_Paulo'));
    if (leitura.motivo === 'nao_conferi') return nao(estado, 'equipe_nao_lida', 'não deu para ler a caixinha «Pausar IA»');

    // 6. é paciente em tratamento? A franquia decide (a mais cara: por último). Unidade sem franquia conectada: nada a perguntar.
    if (unit.spineEnabled && unit.spineToken) {
      const sinal = await deps.franquia(unit, telefone);
      if (sinal.tipo === 'indisponivel') return nao(estado, 'franquia_sem_resposta', sinal.motivo);
      const emTratamento = pacienteEmTratamentoNaFranquia(sinal);
      if (emTratamento) return nao(estado, 'paciente_em_tratamento', emTratamento);
    }

    // 7. reabrir
    const motivoDaPerda = String(
      (lead.custom_fields_values ?? []).find((c) => /motivo do n[aã]o (agendamento|fechamento)/i.test(c.field_name ?? '') && String(c.values?.[0]?.value ?? '').trim())?.values?.[0]?.value ?? '',
    ).trim();
    if (estado === 'seco') {
      deps.simular(unit, ID_PERDIDO_REABRE, {
        leadId,
        acao: 'moveria',
        alvo: ETAPA.QUALIFICACAO,
        deEtapa: ETAPA.PERDIDO,
        motivo: 'o paciente respondeu em PERDIDO',
      });
      return { estado, reabriu: false, decisao: 'reabrir', motivo: 'reabrir', para };
    }
    try {
      await kommo.moveStage({ leadId, statusId: para.statusId, pipelineId: para.pipelineId });
    } catch (err) {
      logger.error({ err: String(err), unit: unit.slug, leadId, statusId: para.statusId }, 'perdido-reabre: o Kommo recusou mover para EM QUALIFICAÇÃO (campo obrigatório?) — o cartão fica em PERDIDO');
      return { estado, reabriu: false, decisao: 'reabrir', motivo: 'falha_ao_mover', detalhe: String(err).slice(0, 160), para };
    }
    // O cartão JÁ andou: nada daqui para baixo pode virar "não reabriu" (o turno tem de seguir e a Sofia responder).
    const falhou = (o: string) => (err: unknown) => logger.warn({ err: String(err), unit: unit.slug, leadId }, `perdido-reabre: o cartão foi movido, mas ${o} falhou (o turno segue)`);
    try {
      invalidarEtapa(unit.id, leadId);
    } catch (err) {
      falhou('limpar o cache da etapa')(err);
    }
    await deps.marcarReaberto(unit.id, leadId).catch(falhou('a marca'));
    await kommo.addLeadNote(leadId, notaCartaoReaberto(p.humanMessage, motivoDaPerda || null)).catch(falhou('a nota'));
    logger.info({ unit: unit.slug, leadId, statusId: para.statusId }, 'perdido-reabre: o paciente respondeu em PERDIDO — cartão voltou para EM QUALIFICAÇÃO');
    return { estado, reabriu: true, decisao: 'reabrir', motivo: 'reabrir', para };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'perdido-reabre: falhou — o cartão fica em PERDIDO como sempre');
    return nao(estado, 'erro', String(err).slice(0, 160));
  }
}
