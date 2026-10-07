/**
 * As etiquetas ▶ que a SDR punha à mão, decididas pelo sistema.
 *
 * Pedido do João (06/10/2026): "as etiquetas precisam ser automatizadas, sem depender da SDR". A
 * etiqueta é só o gatilho — quem manda a mensagem é o bot do Kommo amarrado a ela (régua da Serra,
 * no ar na Açailândia desde 07/10). Por isso cada regra aqui confere também se o MODELO da mensagem
 * vai sair inteiro: etiqueta posta com o campo vazio manda "Aqui é , da Doutor Hérnia" pro paciente.
 *
 * As três regras aprovadas:
 *  - ▶ Boas-vindas     — o cartão entrou em GANHO (COMERCIAL). Espera o programa e a próxima sessão
 *                         estarem no cartão, porque o modelo cita os dois.
 *  - ▶ Confirmar retorno — RETORNO PÓS-TRATAMENTO com o retorno ("◷ Data da Consulta", que é onde o
 *                         sincronizador da franquia grava) nas próximas 24 h. Em EM TRATAMENTO não:
 *                         ali a véspera da sessão já tem bot próprio.
 *  - ▶ Reativação      — 30 dias em PERDIDO sem conversa. Só quem CRUZA os 30 dias agora
 *                         (janela curta): nunca varre o estoque antigo de uma vez.
 * A ▶ Retomada (ligação não atendida) fica de fora: depende do robô da 3C, parado desde 25/08.
 *
 * Tudo aqui é puro (cartão + relógio → decisão) para testar sem Kommo nem banco.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';

export const ETIQUETA = {
  BOAS_VINDAS: '▶ Boas-vindas',
  CONFIRMAR_RETORNO: '▶ Confirmar retorno',
  REATIVACAO: '▶ Reativação',
} as const;
export type Etiqueta = (typeof ETIQUETA)[keyof typeof ETIQUETA];

export const CAMPO = {
  PROXIMA_SESSAO: '◷ Próxima sessão',
  DATA_CONSULTA: '◷ Data da Consulta',
  TRATAMENTO_FECHADO: '⚕ Tratamento fechado',
  RESPONSAVEL: '☻ Responsável agendamento',
  OPT_OUT: '✓ Opt-out WhatsApp',
} as const;

/** Etiquetas que dizem "não mande nada pra este paciente". */
const NAO_CONTATAR = ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'BLOQUEADO_WHATSAPP', 'Fluxo · Opt-out WhatsApp'];
/** Perdido por não ser caso nosso: reativar seria insistir com quem a SDR já descartou. */
const DESQUALIFICADO = ['Fora do escopo'];
/**
 * "☻ Responsável agendamento" que não é gente: o modelo da Reativação diz "Aqui é {responsável}",
 * e "Aqui é DOUTOR DIGITAL" ou "Aqui é I.A SOFIA" é o mesmo tipo de mensagem quebrada que o vazio.
 */
const RESPONSAVEL_QUE_NAO_E_GENTE = /doutor\s*digital|sofia|^\s*i\.?\s*a\.?\s*$/i;
/** Os dois campos de data que deveriam bater no retorno (tolerância de fuso/arredondamento). */
const TOLERANCIA_DATA_S = 2 * 3600;

const HORA = 3600;
const DIA = 24 * HORA;
/** Até quanto tempo depois de entrar em GANHO ainda vale dar as boas-vindas (campos chegam depois). */
export const JANELA_GANHO_S = 2 * DIA;
export const ANTECEDENCIA_RETORNO_S = DIA;
export const DIAS_REATIVACAO = 30;
/** Quem cruzou os 30 dias há mais que isso é estoque antigo: não entra. */
export const JANELA_REATIVACAO_S = 2 * DIA;

export type Decisao =
  | { tipo: 'coloca'; etiqueta: Etiqueta; chave: string; motivo: string; reaplica?: boolean }
  | {
      tipo: 'pula';
      etiqueta: Etiqueta;
      chave: string;
      motivo: string;
      /** Pulou por causa do TEXTO do modelo: com a `_v2` deste modelo aprovada, decide de novo. */
      porModelo?: ModeloSdr;
    };

/** Os modelos das etiquetas ▶ que ganharam uma `_v2` sem buraco (07/10/2026, Açailândia). */
export type ModeloSdr = 'sdr_boas_vindas_programa' | 'sdr_confirmacao_retorno' | 'sdr_reativacao_lead_frio';

type Cartao = Pick<KommoLead, 'id' | 'custom_fields_values' | '_embedded' | 'created_at'> & { closed_at?: number | null };

function valor(lead: Cartao, nome: string): unknown {
  const alvo = normalizarNome(nome);
  const c = lead.custom_fields_values?.find((f) => normalizarNome(f.field_name ?? '') === alvo);
  return c?.values?.[0]?.value;
}

function preenchido(lead: Cartao, nome: string): boolean {
  const v = valor(lead, nome);
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/** Data de campo do Kommo: epoch em segundos — aceita ms e ISO por segurança. */
export function epochSeg(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.floor(n / 1000) : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function temEtiqueta(lead: Cartao, ...nomes: string[]): boolean {
  const tags = (lead._embedded?.tags ?? []).map((t) => t.name);
  return nomes.some((n) => tags.includes(n));
}

function optOut(lead: Cartao): boolean {
  if (temEtiqueta(lead, ...NAO_CONTATAR)) return true;
  return /^\s*sim\s*$/i.test(String(valor(lead, CAMPO.OPT_OUT) ?? ''));
}

const dataBR = (seg: number) =>
  new Date(seg * 1000).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Cartão que está em GANHO (COMERCIAL). `null` = não é com esta regra. O modelo original cita o
 * programa e a próxima sessão; a `_v2` ("Sua vaga no programa de tratamento… está confirmada", com a
 * cartilha) não cita campo nenhum.
 */
export function decidirBoasVindas(lead: Cartao, agora: number, modeloV2 = false): Decisao | null {
  const fechou = epochSeg(lead.closed_at);
  if (!fechou || agora - fechou > JANELA_GANHO_S || fechou > agora + HORA) return null;
  if (temEtiqueta(lead, ETIQUETA.BOAS_VINDAS, 'Fluxo · Boas-vindas enviadas')) return null;
  const chave = `boas-vindas:${lead.id}:${fechou}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.BOAS_VINDAS, chave, motivo: 'paciente pediu para não receber mensagens' };
  const faltam = modeloV2 ? [] : [CAMPO.TRATAMENTO_FECHADO, CAMPO.PROXIMA_SESSAO].filter((c) => !preenchido(lead, c));
  if (faltam.length) {
    return {
      tipo: 'pula',
      etiqueta: ETIQUETA.BOAS_VINDAS,
      chave,
      motivo: `falta ${faltam.join(' e ')} — o modelo sairia com buraco (tenta de novo até 48 h depois do GANHO)`,
      porModelo: 'sdr_boas_vindas_programa',
    };
  }
  return { tipo: 'coloca', etiqueta: ETIQUETA.BOAS_VINDAS, chave, motivo: `entrou em GANHO em ${dataBR(fechou)}` };
}

/**
 * Cartão em RETORNO PÓS-TRATAMENTO. A data vem de "◷ Data da Consulta" (onde a franquia grava o
 * retorno). O modelo original MOSTRA "◷ Próxima sessão": com ele, só põe a etiqueta quando os dois
 * batem, senão o paciente lê uma data errada ou um buraco. A `_v2` mostra a própria Data da Consulta.
 */
export function decidirConfirmarRetorno(lead: Cartao, agora: number, modeloV2 = false): Decisao | null {
  const quando = epochSeg(valor(lead, CAMPO.DATA_CONSULTA));
  if (!quando || quando <= agora || quando - agora > ANTECEDENCIA_RETORNO_S) return null;
  const chave = `retorno:${lead.id}:${quando}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.CONFIRMAR_RETORNO, chave, motivo: 'paciente pediu para não receber mensagens' };
  const mostrada = epochSeg(valor(lead, CAMPO.PROXIMA_SESSAO));
  if (!modeloV2 && (!mostrada || Math.abs(mostrada - quando) > TOLERANCIA_DATA_S)) {
    return {
      tipo: 'pula',
      etiqueta: ETIQUETA.CONFIRMAR_RETORNO,
      chave,
      motivo: `retorno em ${dataBR(quando)}, mas o modelo mostra ${CAMPO.PROXIMA_SESSAO} (${mostrada ? dataBR(mostrada) : 'vazio'}) — trocar o modelo para ${CAMPO.DATA_CONSULTA}`,
      porModelo: 'sdr_confirmacao_retorno',
    };
  }
  return {
    tipo: 'coloca',
    etiqueta: ETIQUETA.CONFIRMAR_RETORNO,
    chave,
    motivo: `retorno em ${dataBR(quando)}`,
    // A etiqueta de um retorno anterior ainda no cartão impediria o gatilho de "etiqueta adicionada".
    reaplica: temEtiqueta(lead, ETIQUETA.CONFIRMAR_RETORNO),
  };
}

type ModeloComStatus = {
  name: string;
  reviews?: ReadonlyArray<{ status?: string }> | null;
  _embedded?: { reviews?: ReadonlyArray<{ status?: string }> | null };
};

/**
 * A unidade já tem a `_v2` deste modelo aprovada na Meta?
 *
 * As `_v2` (07/10/2026) tiram o buraco dos originais: a Reativação diz "a equipe Doutor Digital" em vez
 * de "{responsável}" (decisão do João), a Boas-vindas não cita programa nem data, o retorno mostra a
 * ◷ Data da Consulta. Com a `_v2` APROVADA, assume-se que o bot da etiqueta aponta pra ela — quem cria
 * a v2 numa unidade troca o modelo do bot no mesmo passo. Na dúvida (sem lista), `false`: o lado seguro
 * é pular.
 */
export function temModeloV2(modelos: ReadonlyArray<ModeloComStatus> | null, base: ModeloSdr): boolean {
  if (!modelos || modelos.length === 0) return false;
  // O prefixo da unidade é o mais comum entre os modelos da conta (acai_, serra_…). Sem isso, uma v2
  // de outra unidade na mesma conta (Petrópolis × Caxias, resto da Imperatriz) valeria aqui.
  const conta = new Map<string, number>();
  for (const m of modelos) {
    const p = /^([a-z]+_)/i.exec(m.name)?.[1]?.toLowerCase();
    if (p) conta.set(p, (conta.get(p) ?? 0) + 1);
  }
  const prefixo = [...conta.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
  if (!prefixo) return false;
  const alvo = new RegExp(`^${prefixo}${base}_v\\d+$`, 'i');
  // Aprovado em TODOS os números da conta: aprovado num e pendente noutro = o bot pode cair no errado.
  // Formato conferido na API real em 07/10/2026: `_embedded.reviews[].status` = "approved" | "review" | …
  const aprovado = (m: ModeloComStatus) => {
    const rs = m._embedded?.reviews ?? m.reviews ?? [];
    return rs.length > 0 && rs.every((r) => String(r.status ?? '').toLowerCase() === 'approved');
  };
  return modelos.some((m) => alvo.test(m.name) && aprovado(m));
}

/**
 * Cartão em PERDIDO (COMERCIAL). `ultimaConversa` = última mensagem que o sistema viu com este
 * paciente (epoch s), ou null quando nunca houve conversa pela IA.
 */
export function decidirReativacao(
  lead: Cartao,
  agora: number,
  ultimaConversa: number | null,
  /** a unidade usa a `_v2` com o nome fixo (ver `temModeloV2`) */
  modeloV2 = false,
): Decisao | null {
  const perdeu = epochSeg(lead.closed_at);
  if (!perdeu) return null;
  const desde = agora - perdeu;
  const limite = DIAS_REATIVACAO * DIA;
  if (desde < limite || desde > limite + JANELA_REATIVACAO_S) return null;
  if (temEtiqueta(lead, ETIQUETA.REATIVACAO)) return null;
  const chave = `reativacao:${lead.id}:${perdeu}`;
  if (optOut(lead)) return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: 'paciente pediu para não receber mensagens' };
  if (temEtiqueta(lead, ...DESQUALIFICADO)) return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: 'perdido como fora do escopo' };
  const criado = epochSeg(lead.created_at);
  if (criado && perdeu - criado < HORA) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: 'o cartão nasceu em PERDIDO (importação/carga) — os 30 dias não são do paciente' };
  }
  if (ultimaConversa && agora - ultimaConversa < limite) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `conversou em ${dataBR(ultimaConversa)}, menos de ${DIAS_REATIVACAO} dias` };
  }
  const responsavel = String(valor(lead, CAMPO.RESPONSAVEL) ?? '').trim();
  if (!modeloV2 && !responsavel) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `${CAMPO.RESPONSAVEL} vazio — o modelo sairia "Aqui é , da Doutor Hérnia"`, porModelo: 'sdr_reativacao_lead_frio' };
  }
  if (!modeloV2 && RESPONSAVEL_QUE_NAO_E_GENTE.test(responsavel)) {
    return { tipo: 'pula', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `${CAMPO.RESPONSAVEL} = ${responsavel} — o modelo sairia "Aqui é ${responsavel}, da Doutor Hérnia"`, porModelo: 'sdr_reativacao_lead_frio' };
  }
  return { tipo: 'coloca', etiqueta: ETIQUETA.REATIVACAO, chave, motivo: `${DIAS_REATIVACAO} dias em PERDIDO (desde ${dataBR(perdeu)}) sem conversa` };
}
