/**
 * A rotina diária dos robôs (pedido do João, 06/11/2026): "todo dia os bots trabalham em favor das meninas".
 *
 * O gatilho do Kommo só dispara em EVENTO (entrar na etapa, data do cartão, etiqueta). Escapam: quem já estava na
 * etapa quando o gatilho nasceu, quem tem o campo de data vazio, quem está parado numa etapa sem gatilho de tempo.
 * Esta rotina varre o funil todo dia, em horário comercial, e faz o toque que a SDR faria — pondo a etiqueta ▶ que
 * dispara o robô do Kommo, que manda o MODELO do WhatsApp (a mesma mecânica do `etiquetas-auto`).
 *
 * TRÊS RÉGUAS, três chaves no catálogo (cada uma liga/desliga por unidade na tela), um worker e UM teto por dia:
 *  - `rotina-robos`      — esquecidos por etapa: EM QUALIFICAÇÃO [2,4,7], NÃO COMPARECEU [1,3,6], EM NEGOCIAÇÃO [2,5,9]
 *                          dias sem resposta → ▶ Retomada, ▶ Retomada 2, ▶ Retomada 3.
 *  - `rotina-exlead`     — quem NUNCA agendou, hoje em PERDIDO ou EM ESPERA: 30/60/90 dias desde a última mensagem dele
 *                          → ▶ Reativação, ▶ Reativação 2, ▶ Reativação 3. Absorve a Reativação do `etiquetas-auto`.
 *  - `rotina-aniversario`— no dia do aniversário (fuso da unidade, de manhã): ▶ Aniversário (com convite) ou
 *                          ▶ Aniversário tratamento (só parabéns, para quem está em tratamento ativo). 1 por ano.
 *
 * O dia do dia 1 NÃO é daqui: nas primeiras 24 h o `follow-up-24h` da Sofia fala DENTRO da janela do WhatsApp
 * (5 min, 30 min, 2 h, 6 h, 20 h). A rotina começa depois, com MODELO (a janela já fechou).
 *
 * O DESENHO é o da régua de PERDIDO que já existe no Kommo (`lead_reengajamento_48h` / `metodo_convite_96h` /
 * `encerramento_120h`): um robô e um modelo por degrau, e a etiqueta NO_FOLLOW_UP corta tudo. A diferença é o
 * gatilho: lá é "N horas depois de entrar na etapa" (evento), aqui é "N dias sem o paciente escrever" (estado) —
 * o Kommo não sabe contar isso, e é justamente o que escapava.
 *
 * Tudo aqui é PURO (cartão + relógio → decisão) para testar sem Kommo nem banco. Quem lê e escreve está em
 * `rotina-robos-worker.ts`.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { caixinhaMarcada } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { ETAPA } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { valorDoCampo } from './ponte-fila.js';
import { comConsultaFutura } from './trava-perda.js';
import { diaDaRetomada, diaDoCampoData, hojeNaUnidade, retomarEmDoCartao } from './espera-retomada.js';
import { ETIQUETAS_DE_NAO_CONTATAR } from './sofia-fecha-quente-morno.js';
import { ETIQUETA_CURRICULO } from './nao-paciente.js';
import { CAMPO, TAG_SEM_REGUA, nomesDoCampo } from './parados.js';
import { epochDoCartao } from './paciente-para-cartao.js';

export const ID_ROTINA_ETAPAS = 'rotina-robos';
export const ID_ROTINA_EXLEAD = 'rotina-exlead';
export const ID_ROTINA_ANIVERSARIO = 'rotina-aniversario';

const DIA_S = 86_400;
export const MAX_TOQUES = 3;

// ─── as réguas ────────────────────────────────────────────────────────────────────────────────────

export interface ReguaPorEtapa {
  /** vai no id da marca: sem hífen */
  chave: 'qualificacao' | 'naocompareceu' | 'negociacao';
  etapa: string;
  /** dias sem resposta de cada toque (o 1º toque, o 2º...) */
  dias: readonly number[];
}

/** Os prazos do João (06/11/2026). O dia 1 da QUALIFICAÇÃO é da Sofia (follow-up-24h), por isso começa em 2. */
export const REGUAS_POR_ETAPA: readonly ReguaPorEtapa[] = [
  { chave: 'qualificacao', etapa: ETAPA.QUALIFICACAO, dias: [2, 4, 7] },
  { chave: 'naocompareceu', etapa: ETAPA.NAO_COMPARECEU, dias: [1, 3, 6] },
  { chave: 'negociacao', etapa: ETAPA.NEGOCIACAO, dias: [2, 5, 9] },
];

export const DIAS_EXLEAD: readonly number[] = [30, 60, 90];
export const ETAPAS_DO_EXLEAD = [ETAPA.PERDIDO, ETAPA.ESPERA] as const;
export const CHAVE_EXLEAD = 'exlead';
export const CHAVE_ANIVERSARIO = 'aniv';

/** Uma etiqueta por degrau: o robô de cada uma manda o modelo daquele degrau (o gatilho é "etiqueta adicionada"). */
export const ETIQUETAS_RETOMADA: readonly string[] = ['▶ Retomada', '▶ Retomada 2', '▶ Retomada 3'];
export const ETIQUETAS_EXLEAD: readonly string[] = ['▶ Reativação', '▶ Reativação 2', '▶ Reativação 3'];
export const ETIQUETA_ANIVERSARIO = '▶ Aniversário';
export const ETIQUETA_ANIVERSARIO_TRATAMENTO = '▶ Aniversário tratamento';

export const TETO_DIA_PADRAO = 30;
export const POR_VARREDURA_PADRAO = 10;
/** Quem está calado há mais que isto e nunca recebeu o 1º toque é ESTOQUE ANTIGO: não entra (é do `parados`). */
export const MAX_SILENCIO_ETAPAS_DIAS = 30;
/** Ex-lead: o 1º toque só vale enquanto o silêncio está em [30, 30 + isto). Estoque mais velho não entra de uma vez. */
export const ENTRADA_EXLEAD_DIAS = 30;
/** O aniversário sai de manhã (hora local da unidade): de HORA_ANIVERSARIO_DE até HORA_ANIVERSARIO_ATE. */
export const HORA_ANIVERSARIO_DE = 9;
export const HORA_ANIVERSARIO_ATE = 12;

// ─── configuração por unidade ─────────────────────────────────────────────────────────────────────

/**
 * O que a tela de unidade guarda hoje em `pipelineIntents` é {chave: inteiro positivo}. A configuração da rotina vai ali
 * (sem migração), uma chave por número:
 *   rotina_teto_dia · rotina_<etapa>_d1..d3 · rotina_exlead_d1..d3 · rotina_toques_prontos · rotina_exlead_toques_prontos
 * Ausente = o padrão do João. Prazos que não crescem (4, 2, 7) ou fora de 1..365 = os padrões, e o log avisa.
 */
export interface ConfigDaRotina {
  teto: number;
  porVarredura: number;
  etapas: Record<ReguaPorEtapa['chave'], number[]>;
  exlead: number[];
  /** quantos degraus de ▶ Retomada têm etiqueta + robô + modelo prontos NA CONTA (o gatilho do Kommo só se lê com sessão) */
  toquesProntosEtapas: number;
  toquesProntosExlead: number;
  invalidas: string[];
}

function inteiro(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function prazos(padrao: readonly number[], intents: Record<string, unknown>, prefixo: string, env: string | undefined, invalidas: string[]): number[] {
  const doEnv = String(env ?? '')
    .split(',')
    .map((s) => inteiro(s.trim()))
    .filter((n): n is number => n !== null);
  const base = doEnv.length ? doEnv.slice(0, MAX_TOQUES) : [...padrao];
  const lista = base.map((d, i) => inteiro(intents[`${prefixo}_d${i + 1}`]) ?? d);
  const ok = lista.every((d, i) => d <= 365 && (i === 0 || d > lista[i - 1]));
  if (!ok) {
    invalidas.push(`${prefixo}: ${lista.join(',')}`);
    return [...padrao];
  }
  return lista;
}

export function configDaUnidade(pipelineIntents: unknown, env: Record<string, string | undefined> = process.env): ConfigDaRotina {
  const intents = (pipelineIntents && typeof pipelineIntents === 'object' && !Array.isArray(pipelineIntents) ? pipelineIntents : {}) as Record<string, unknown>;
  const invalidas: string[] = [];
  const etapas = {} as ConfigDaRotina['etapas'];
  for (const r of REGUAS_POR_ETAPA) etapas[r.chave] = prazos(r.dias, intents, `rotina_${r.chave}`, env[`ROTINA_ROBOS_DIAS_${r.chave.toUpperCase()}`], invalidas);
  const limite = (v: number | null, max: number, padrao: number) => (v === null ? padrao : Math.min(v, max));
  return {
    teto: limite(inteiro(intents.rotina_teto_dia) ?? inteiro(env.ROTINA_ROBOS_TETO_DIA), 500, TETO_DIA_PADRAO),
    porVarredura: limite(inteiro(env.ROTINA_ROBOS_POR_VARREDURA), 100, POR_VARREDURA_PADRAO),
    etapas,
    exlead: prazos(DIAS_EXLEAD, intents, 'rotina_exlead', env.ROTINA_ROBOS_DIAS_EXLEAD, invalidas),
    toquesProntosEtapas: limite(inteiro(intents.rotina_toques_prontos), MAX_TOQUES, 1),
    toquesProntosExlead: limite(inteiro(intents.rotina_exlead_toques_prontos), MAX_TOQUES, 1),
    invalidas,
  };
}

// ─── a marca (1 por cartão, etapa, silêncio e degrau) ─────────────────────────────────────────────

/**
 * Um rastro em `execution_traces` por degrau enviado, gravado ANTES da etiqueta (como no `etiquetas-auto`): se a marca
 * não grava, a etiqueta não sai. O id é determinístico — mesma unidade, cartão, régua, degrau e mensagem do paciente — e o
 * banco recusa o segundo. `tp` = a última mensagem do paciente (epoch s) quando o degrau saiu; no aniversário, o ano.
 */
export const PREFIXO_DA_MARCA = 'rotina-';

export function idDaMarca(unitId: string, quem: number | string, chave: string, toque: number, tp: number): string {
  return `${PREFIXO_DA_MARCA}${unitId}-${quem}-${chave}-${toque}-${tp}`;
}

export interface MarcaLida {
  leadId: number;
  chave: string;
  toque: number;
  /** quando saiu (epoch s) */
  em: number;
}

/** Lê chave, degrau e `tp` do FIM do id (o id da unidade pode ter hífen). `null` = não é marca da rotina. */
export function lerMarca(id: string, leadId: number, criadaEm: Date): MarcaLida | null {
  if (!id.startsWith(PREFIXO_DA_MARCA)) return null;
  const partes = id.split('-');
  const chave = partes[partes.length - 3];
  const toque = Number(partes[partes.length - 2]);
  if (!chave || !Number.isInteger(toque) || toque < 1) return null;
  return { leadId, chave, toque, em: Math.floor(criadaEm.getTime() / 1000) };
}

/** As marcas desta régua que valem para o silêncio de AGORA: as de depois da última mensagem do paciente. Ele escreveu = zera. */
export function marcasDoSilencio(marcas: readonly MarcaLida[], chave: string, ultimaDoPaciente: number): Array<{ toque: number; em: number }> {
  return marcas.filter((m) => m.chave === chave && m.em > ultimaDoPaciente).map((m) => ({ toque: m.toque, em: m.em }));
}

// ─── o que o CARTÃO diz (sem chamada nenhuma) ─────────────────────────────────────────────────────

/** Etiquetas que dizem "não mande nada pra este paciente" (as do `etiquetas-auto` + as das outras travas). */
const NAO_CONTATAR = [
  'NO_FOLLOW_UP',
  'NAO_PERTURBAR',
  'BLOQUEADO_WHATSAPP',
  'Fluxo · Opt-out WhatsApp',
  ...ETIQUETAS_DE_NAO_CONTATAR,
  TAG_SEM_REGUA,
  ETIQUETA_CURRICULO,
  'Fora do escopo',
].map(normalizarNome);

/**
 * Motivos de perda que a SDR ou a IA escolhem quando o caso ESTÁ ENCERRADO — insistir é spam. Os cinco do João (06/11/2026)
 * mais os de risco que o resto da casa já trata como intocáveis (bandeira vermelha, contrato assinado, outra cidade).
 * "Sem condições financeiras" NÃO está aqui: a perda-ia a trata como trabalhável (decisão de 02/10).
 */
const MOTIVOS_MORTOS = [
  'Outra cidade',
  'Mora em outra cidade',
  'Clicou por engano',
  'Outra patologia',
  'Plano de Saúde',
  'Sem interesse',
  'Bandeira vermelha',
  'Financeiramente vulnerável',
  'Assinou contrato',
  'Caso enviado para a franquia',
  'Informação para terceiro',
].map(normalizarNome);

type Cartao = Pick<KommoLead, 'custom_fields_values' | '_embedded'>;

function tags(lead: Cartao): string[] {
  return (lead._embedded?.tags ?? []).map((t) => normalizarNome(t.name ?? ''));
}

export function temEtiqueta(lead: Cartao, nome: string): boolean {
  return tags(lead).includes(normalizarNome(nome));
}

/** O motivo de perda "morto" que o cartão carrega (nos dois campos ⊘), ou null. */
export function motivoMorto(lead: Cartao): string | null {
  for (const campo of [CAMPO.MOTIVO_NAO_AGENDAMENTO, CAMPO.MOTIVO_NAO_FECHAMENTO]) {
    for (const nome of nomesDoCampo(campo)) {
      const v = String(valorDoCampo(lead.custom_fields_values, nome) ?? '').trim();
      if (v && MOTIVOS_MORTOS.includes(normalizarNome(v))) return v;
    }
  }
  return null;
}

export interface RazaoDeFicar {
  /** curto, estável: vira a chave do contador do resumo */
  codigo: string;
  texto: string;
}

export interface OpcoesDeCartao {
  agora: number;
  tz: string;
  pausarIaFieldId: number | null;
  /** confere o motivo de perda "morto" (ex-lead e aniversário); as réguas por etapa não olham PERDIDO */
  conferirMotivoMorto?: boolean;
  /** aniversário: só as travas de "não contatar" — Pausar IA, ◷ Retomar em e consulta futura NÃO impedem um parabéns */
  soNaoContatar?: boolean;
}

/**
 * Por que o cartão NÃO recebe toque — só o que se vê nele, de graça. `null` = pode seguir para as conferências que custam
 * chamada. Vale para as três réguas.
 */
export function porQueNaoTocar(lead: Cartao, o: OpcoesDeCartao): RazaoDeFicar | null {
  const t = tags(lead);
  if (NAO_CONTATAR.some((n) => t.includes(n))) return { codigo: 'nao-contatar', texto: 'etiqueta de não contatar, currículo ou fora do escopo' };
  if (/^\s*sim\s*$/i.test(String(valorDoCampo(lead.custom_fields_values, '✓ Opt-out WhatsApp') ?? ''))) {
    return { codigo: 'opt-out', texto: 'paciente pediu para não receber mensagens (✓ Opt-out WhatsApp)' };
  }
  if (o.conferirMotivoMorto) {
    const m = motivoMorto(lead);
    if (m) return { codigo: 'motivo-morto', texto: `perdido por «${m}»: caso encerrado` };
  }
  if (o.soNaoContatar) return null;
  if (o.pausarIaFieldId !== null) {
    const campo = (lead.custom_fields_values ?? []).find((c) => c.field_id === o.pausarIaFieldId);
    if (caixinhaMarcada(campo?.values?.[0]?.value)) return { codigo: 'pausar-ia', texto: '«Pausar IA» marcado: tem gente com o paciente' };
  }
  const dia = diaDaRetomada(retomarEmDoCartao(lead.custom_fields_values), o.agora, o.tz);
  if (dia === 'futuro' || dia === 'hoje') return { codigo: 'retomar-em', texto: `◷ Retomar em ${dia === 'hoje' ? 'é hoje' : 'está no futuro'}: alguém decidiu esperar` };
  if (comConsultaFutura(lead, o.agora)) return { codigo: 'consulta-futura-cartao', texto: 'consulta futura no cartão' };
  return null;
}

/** Cartão que MOSTRA que o paciente já passou por consulta ou tratamento (a franquia confere depois, para quem passou neste teste). */
export function cartaoMostraConsulta(lead: Cartao): boolean {
  const c = lead.custom_fields_values;
  const preenchido = (nome: string) => {
    const v = valorDoCampo(c, nome);
    return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'false' && String(v) !== '0';
  };
  return [CAMPOS_SYNC.DATA_CONSULTA, CAMPOS_SYNC.SITUACAO, CAMPOS_SYNC.COMPARECEU, CAMPOS_SYNC.TRAT_FECHADO, CAMPOS_SYNC.FECHOU_TRAT].some(preenchido);
}

// ─── o degrau da vez (puro) ───────────────────────────────────────────────────────────────────────

export type DecisaoDoToque =
  | { tipo: 'toca'; toque: number; etiqueta: string; silencioDias: number; atrasado: boolean }
  /** o degrau existe e vence, mas a conta não tem o gatilho dele confirmado: no papel aparece, ligado não manda */
  | { tipo: 'sem-gatilho'; toque: number; etiqueta: string; silencioDias: number }
  | { tipo: 'espera'; porque: string; ate: number | null }
  | { tipo: 'esgotada' }
  | { tipo: 'fora'; porque: string };

export interface EntradaDoToque {
  agora: number;
  /** dias sem resposta de cada degrau */
  dias: readonly number[];
  etiquetas: readonly string[];
  /** quantos degraus têm etiqueta + robô + gatilho prontos na conta */
  prontos: number;
  /** última mensagem do paciente (epoch s). null = não escreveu na janela olhada */
  ultimaDoPaciente: number | null;
  /** os degraus já enviados NESTE silêncio (depois da última mensagem dele) */
  marcas: ReadonlyArray<{ toque: number; em: number }>;
  /** o 1º degrau só vale se o silêncio for menor que isto (dias): estoque mais velho não entra */
  entradaAteDias: number;
}

/**
 * Qual degrau sai AGORA para este cartão — ou por que nenhum. Regras:
 *  - sem mensagem do paciente na janela: não é "esquecido", é lead que nunca respondeu (régua da Sofia e `parados`);
 *  - ordem 1→2→3, sem repetir e sem pular: o próximo é o maior degrau já enviado + 1;
 *  - o degrau N só sai com N dias de silêncio E com o espaço do desenho (dias[N] − dias[N−1]) depois do degrau anterior —
 *    quem entra atrasado leva o 1º hoje e o 2º só no espaço certo, nunca dois no mesmo dia;
 *  - acabou a régua sem resposta: não manda mais nada (quem move é o `parados`).
 */
export function decidirToque(e: EntradaDoToque): DecisaoDoToque {
  if (e.ultimaDoPaciente === null) return { tipo: 'fora', porque: 'o paciente não escreveu na janela olhada: não é esquecido' };
  const silencio = e.agora - e.ultimaDoPaciente;
  const silencioDias = Math.floor(silencio / DIA_S);
  const ultimoEnviado = e.marcas.reduce((m, x) => Math.max(m, x.toque), 0);
  const proximo = ultimoEnviado + 1;
  if (proximo > e.dias.length) return { tipo: 'esgotada' };
  if (ultimoEnviado === 0 && silencio >= e.entradaAteDias * DIA_S) {
    return { tipo: 'fora', porque: `calado há ${silencioDias} dias, mais que a janela de entrada (${e.entradaAteDias}): estoque antigo` };
  }
  const prazo = e.dias[proximo - 1] * DIA_S;
  if (silencio < prazo) return { tipo: 'espera', porque: `${silencioDias} dia(s) de silêncio; o ${proximo}º toque é com ${e.dias[proximo - 1]}`, ate: e.ultimaDoPaciente + prazo };
  if (proximo > 1) {
    const anterior = e.marcas.filter((m) => m.toque === ultimoEnviado).reduce((m, x) => Math.max(m, x.em), 0);
    const espaco = (e.dias[proximo - 1] - e.dias[proximo - 2]) * DIA_S;
    if (e.agora - anterior < espaco) return { tipo: 'espera', porque: `o ${proximo}º toque espera ${e.dias[proximo - 1] - e.dias[proximo - 2]} dia(s) depois do anterior`, ate: anterior + espaco };
  }
  const etiqueta = e.etiquetas[proximo - 1];
  if (!etiqueta) return { tipo: 'esgotada' };
  if (proximo > e.prontos) return { tipo: 'sem-gatilho', toque: proximo, etiqueta, silencioDias };
  // já passou do prazo do degrau seguinte: pelo calendário estaria mais adiante, mas entra pelo próximo da fila (não pula)
  const seguinte = e.dias[proximo];
  return { tipo: 'toca', toque: proximo, etiqueta, silencioDias, atrasado: seguinte !== undefined && silencio >= seguinte * DIA_S };
}

// ─── aniversário (puro) ───────────────────────────────────────────────────────────────────────────

/** Nascimento do cartão (epoch s do campo ◷ Data de nascimento), ou null. */
export function nascimentoDoCartao(lead: Cartao): number | null {
  const v = valorDoCampo(lead.custom_fields_values, '◷ Data de nascimento');
  return v == null ? null : epochDoCartao(String(v));
}

/** O dia (AAAA-MM-DD) que a ficha da franquia diz (ISO ou dd/mm/aaaa), ou null. */
export function diaDeNascimentoDaFicha(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return iso && !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? iso : null;
}

/** Dias de atraso que o aniversário aceita: a unidade fechada no sábado, no domingo ou no feriado cumprimenta no 1º dia útil. */
export const ATRASO_MAX_ANIVERSARIO_DIAS = 2;

/**
 * É aniversário hoje, no fuso da unidade? `dia` = AAAA-MM-DD do nascimento. Com `atrasoMax`, vale também o aniversário dos
 * últimos N dias (o 1º dia útil depois do fim de semana ou do feriado) — a marca de «1 por ano» impede o repique.
 * 29/02 comemora em 28/02 nos anos sem bissexto. Ano absurdo (futuro, antes de 1900) = não manda: data de nascimento
 * digitada errada é pior que não mandar.
 */
export function aniversarioNoDia(dia: string | null, agora: number, tz: string, atrasoMax = 0): boolean {
  if (!dia) return false;
  const ano = Number(dia.slice(0, 4));
  const anoAgora = Number(hojeNaUnidade(agora, tz).slice(0, 4));
  if (!Number.isFinite(ano) || ano < 1900 || ano >= anoAgora) return false;
  const md = dia.slice(5);
  for (let k = 0; k <= atrasoMax; k++) {
    const hoje = hojeNaUnidade(agora - k * DIA_S, tz);
    const anoDoDia = Number(hoje.slice(0, 4));
    const bissexto = (anoDoDia % 4 === 0 && anoDoDia % 100 !== 0) || anoDoDia % 400 === 0;
    if (md === hoje.slice(5) || (md === '02-29' && !bissexto && hoje.slice(5) === '02-28')) return true;
  }
  return false;
}

/** Aniversário a partir de um campo `date` do Kommo (epoch s, meia-noite no fuso da conta). */
export function aniversarioHoje(nascimento: number | null, agora: number, tz: string, atrasoMax = 0): boolean {
  return nascimento === null ? false : aniversarioNoDia(diaDoCampoData(nascimento), agora, tz, atrasoMax);
}

/** Hora local (0–23) da unidade. */
export function horaLocal(agora: number, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(agora * 1000))) % 24;
}

export function naJanelaDoAniversario(agora: number, tz: string): boolean {
  const h = horaLocal(agora, tz);
  return h >= HORA_ANIVERSARIO_DE && h < HORA_ANIVERSARIO_ATE;
}

/** Texto do cartão que a franquia chama de óbito/inativo: nunca recebe parabéns. */
export function statusDeFalecido(status: string | null | undefined): boolean {
  return /[oó]bito|falec|faleceu/i.test(String(status ?? ''));
}
