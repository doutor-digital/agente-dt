/**
 * Ponte, fase 4 (0.4.0, 14/10/2026) — o botão "O QUE EU FAÇO AGORA?": o guia da SDR pela etapa do cartão.
 *
 * Decidido pelo João (14/10/2026):
 *   1. o guia mostra a ⚠ Pendência do cartão (o campo fica OCULTO no Kommo e a SDR só achava o motivo no
 *      histórico — decisão D13) e os campos que FALTAM para a etapa atual e para as próximas possíveis: os
 *      obrigatórios do Kommo e os que são "da SDR". Os que o robô, a Sofia ou a franquia preenchem não aparecem;
 *   2. deixa preencher ali mesmo (texto, lista, data, número) — o painel mostra antes o que vai gravar;
 *   3. oferece as SAÍDAS da etapa e só move com os obrigatórios do destino preenchidos, com confirmação explícita
 *      e o aviso de que os robôs da etapa podem mandar mensagem ao paciente;
 *   4. Petrópolis × Caxias: na conta que tem o campo ⌂ Unidade de atendimento, com ele vazio o PRIMEIRO passo é
 *      escolher a unidade (a franquia de cada uma é outra: cadastrar um paciente na unidade errada "dá BO");
 *   5. a Ponte NÃO escreve na franquia (nada de marcar consulta);
 *   6. só as etapas do COMERCIAL que são da SDR: nunca GANHO nem o funil TRATAMENTO (são da franquia e dos robôs).
 *
 * OBRIGATÓRIO É CUMULATIVO no Kommo (provado na Marabá em 26/08/2026): para entrar numa etapa pela tela, o cartão
 * precisa dos obrigatórios dela E de todas as etapas antes dela no funil. GANHO (142) cobra os do funil inteiro.
 * PERDIDO (143) cobra só os dele: o João testou na Serra em 02/10/2026 que mover para PERDIDO não pede os de GANHO
 * (e a SDR perde cartão em EM QUALIFICAÇÃO sem preencher o que é da consulta). A API não confere obrigatório nenhum
 * (o PATCH passa com tudo vazio) — quem segura aqui é a Ponte, com a MESMA regra da tela.
 *
 * Campos e etapas são achados pelo NOME (os ids mudam de conta para conta). 142/143 se repetem em todo funil: a
 * chave de uma etapa é SEMPRE o par (funil, etapa).
 *
 * Por que lista e não "ler os gatilhos do Kommo": os gatilhos só saem pela rota /ajax/v4/triggers/bots, que pede o
 * cookie de sessão de um usuário (o token da API não lê). Então o painel avisa SEMPRE que os robôs podem mandar
 * mensagem, e as mensagens conhecidas de cada etapa ficam em `MENSAGENS_DA_ETAPA` (Açailândia, régua de 07/10/2026)
 * e na variável de ambiente `PONTE_MENSAGENS_DA_ETAPA_<SLUG>`.
 *
 * Esta é a parte com as REGRAS. O Kommo entra por uma interface (`KommoDoGuia`): o controller passa o de verdade
 * e o teste, um falso. Log e resposta nunca levam o valor dos campos para o log (só nomes e ids).
 */
import { KommoApiError } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { ETAPA, ehEtapaDeEntrada } from './franquia-move.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { CAMPO } from './parados.js';
import { CAMPO_UNIDADE } from './unidade-por-canal.js';
import { dataBRNoFuso, offsetMinutosNoFuso } from './fuso.js';
import { dataLocalISO } from './feriados.js';
import { numeroDoAmbiente } from './ponte-fila.js';
import { POR_PADRAO, leadIdDoPedido, textoCurto, type Lido } from './ponte-pausa.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';

export const GANHO = 142;
export const PERDIDO = 143;

/** O campo oculto em que o `card-validation-worker` escreve o que está errado no cartão (decisão D13: mostrar). */
export const CAMPO_PENDENCIA = '⚠ Pendência do cartão';

/** A etiqueta que tira o paciente de toda régua de mensagens (o gatilho do PERDIDO confere no evento). */
export const ETIQUETA_SEM_MENSAGEM = 'NO_FOLLOW_UP';

/** O que o painel diz em TODA saída: o servidor não lê os gatilhos, então avisa sempre. */
export const AVISO_DOS_ROBOS = 'Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.';

// ── os nomes ──

/** "## CONSULTA", "##^Paciente", "*AGENDADO*", "*AUTOMÁTICO · NÃO PREENCHER": cabeçalho visual, nunca guarda valor. */
export function ehCabecalho(nome: string | null | undefined): boolean {
  return /^\s*(##|\*)/.test(String(nome ?? ''));
}

const mesmoNome = (a: string | null | undefined, b: string) => !!a && normalizarNome(a) === normalizarNome(b);

/** Nomes que são o mesmo campo em gerações diferentes do cartão (o enxuto encurtou alguns). */
const NOMES_ALTERNATIVOS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [normalizarNome('⊘ Motivo de não fechamento do tratamento')]: ['⊘ Motivo de não fechamento'],
  [normalizarNome('⊘ Motivo de não fechamento')]: ['⊘ Motivo de não fechamento do tratamento'],
});

function casaNome(nomeDoCampo: string, procurado: string): boolean {
  if (mesmoNome(nomeDoCampo, procurado)) return true;
  return (NOMES_ALTERNATIVOS[normalizarNome(procurado)] ?? []).some((alt) => mesmoNome(nomeDoCampo, alt));
}

/** O campo da conta com este nome (ou um nome alternativo). Cabeçalho nunca. */
export function campoPorNome<T extends Pick<DefinicaoDeCampo, 'name'>>(defs: ReadonlyArray<T>, nome: string): T | null {
  return defs.find((d) => !ehCabecalho(d.name) && casaNome(d.name, nome)) ?? null;
}

// ── quem preenche cada campo ──

/**
 * Campos da FRANQUIA: o sincronizador (consulta, pessoa, sessões) e a tela da franquia escrevem. A Ponte não
 * escreve na franquia, e escrever estes no cartão seria inventar consulta — o guia diz "quem preenche é a franquia".
 */
export const CAMPOS_DA_FRANQUIA: readonly string[] = Object.freeze([
  CAMPOS_SYNC.DATA_CONSULTA,
  CAMPOS_SYNC.SITUACAO,
  CAMPOS_SYNC.COMPARECEU,
  CAMPOS_SYNC.FISIO,
  CAMPOS_SYNC.CATEGORIA,
  CAMPOS_SYNC.AGENDADO_SDR_EM,
  CAMPOS_SYNC.FEITO_POR,
  CAMPOS_SYNC.FECHOU_TRAT,
  CAMPOS_SYNC.TRAT_FECHADO,
  '# Idade',
  '⚑ Origem na franquia',
  '✓ Status do paciente',
  '⌂ Cidade',
  '⌂ Endereço',
  '⚥ Sexo',
  '◷ Próxima sessão',
  '# Sessões realizadas',
  '# Sessões agendadas (por vir)',
  '# Sessões marcadas',
  '# Sessões no histórico',
  '# Sessões previstas',
  '# Nº de faltas',
  '⚕ Local do tratamento',
  '⚕ Grau',
  '⚕ Status do tratamento',
  '◷ Última sessão',
  '◷ Início do tratamento',
  '◷ Fim do tratamento',
  '⊘ Motivo para não realizar o tratamento',
]);

/** Campos AUTOMÁTICOS (métricas, Sofia, revisão, pausa): ninguém preenche à mão. */
export const CAMPOS_AUTOMATICOS: readonly string[] = Object.freeze([
  CAMPO_PENDENCIA,
  'Pausar IA',
  'Resposta da IA',
  '◷ Data do primeiro contato',
  '◷ Data/hora da 1ª resposta',
  '# Tempo até 1ª resposta (min)',
  '◷ Data da qualificação',
  '# Tempo até agendamento (h)',
  '⬢ Status da conversa',
  '# Nº de mensagens trocadas',
  '⬢ Intenção principal',
  '⬢ Sentimento do lead',
  '✓ Interação',
  '⌂ Unidade',
  '✓ Opt-out WhatsApp',
  '◷ Data do opt-out',
  '✓ Atendimento assumido por humano',
  '⬢ Motivo do handoff',
  '⬢ Tipo de resgate',
  '⬢ Tentativas de resgate',
  '# Nº de tentativas de contato',
  'Consulta pg no dia',
]);

/**
 * Campos do ANÚNCIO (o rastreio grava). Viram da SDR só quando a conta os exige (Imperatriz exige ⚑ Origem na
 * qualificação: paciente que não veio de anúncio tem a origem escolhida pela SDR na tela).
 */
export const CAMPOS_DO_ANUNCIO: readonly string[] = Object.freeze([
  '⚑ Origem',
  '⌂ Campanha',
  '⌂ Conjunto de anúncio',
  '⌂ Anúncio (ad)',
  '⌂ Título do anúncio',
  '⌂ ID do anúncio',
  '⌂ Imagem do anúncio',
  '⌂ Plataforma de origem',
  '⌂ URL de origem do clique',
  '⌂ ctwa_clid',
  '⌂ Cliques no anúncio',
  '⌂ Último anúncio',
]);

/**
 * Os campos da SDR em cada etapa (o molde da Serra e da Açailândia, 02/10/2026: o bloco `*ETAPA*` de cada uma, sem
 * os "Apenas API" e sem o que robô preenche). Inclui os que a Sofia captura (Qualificação, Queixa, Região da dor,
 * Motivo da espera, Retomar em): numa unidade sem Sofia — ou quando ela não pegou — quem preenche é a SDR. O guia
 * só mostra os que estão VAZIOS e não estão escondidos na etapa.
 */
export const CAMPOS_DA_SDR_POR_ETAPA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ETAPA.QUALIFICACAO]: ['★ Qualificação (Quente/Morno/Frio)', '⚕ Região da dor', '✎ Queixa', '✎ Observações'],
  [ETAPA.ESPERA]: [CAMPO.MOTIVO_ESPERA, CAMPO.RETOMAR_EM],
  [ETAPA.AGENDADO]: ['¤ Valor da Consulta', '¤ Pagamento antecipado'],
  [ETAPA.NAO_COMPARECEU]: ['⊘ Motivo da falta'],
  [ETAPA.COMPARECEU]: ['⚕ Tratamento indicado'],
  [ETAPA.NEGOCIACAO]: ['⊘ Motivo de não fechamento do tratamento'],
  [ETAPA.RETORNO]: ['✎ Relato do retorno'],
  [ETAPA.GANHO]: ['◉ Semáforo', '⬢ Forma de pagamento', '¤ Valor do tratamento'],
  [ETAPA.PERDIDO]: [CAMPO.MOTIVO_NAO_AGENDAMENTO],
  [ETAPA.ALTA]: ['✓ Deixou avaliação (Google)', '★ Satisfação do Tratamento'],
  [ETAPA.CANCELADO]: ['⊘ Motivo do cancelamento do tratamento'],
});

/** Uma saída da etapa: para onde a SDR pode mandar o cartão, e o que a Ponte pede antes. */
export interface SaidaDaEtapa {
  /** A etapa de destino, pelo nome (`ETAPA.*`). */
  para: string;
  /** O que aconteceu, do jeito que a SDR fala. */
  rotulo: string;
  /** Campos que a Ponte EXIGE antes de mover (além dos obrigatórios do Kommo). Campo que a conta não tem é pulado. */
  pede?: readonly string[];
  /** Campos que aparecem para preencher, sem travar. */
  sugere?: readonly string[];
  /** Campo de DATA que precisa ser hoje ou depois (AGENDADO com a consulta de ontem é cartão errado). */
  futura?: string;
  /** Um lembrete para a SDR nesta saída. */
  dica?: string;
}

const DESMARQUE_NA_FRANQUIA =
  'A Ponte não mexe na franquia: desmarque a consulta lá também. Se a franquia ainda tiver a consulta marcada, o robô da franquia pode trazer o cartão de volta para AGENDADO.';

const S = {
  comecar: { para: ETAPA.QUALIFICACAO, rotulo: 'Comecei a atender' },
  voltou: { para: ETAPA.QUALIFICACAO, rotulo: 'O paciente voltou a conversar' },
  // a data da consulta entra sozinha (franquia, widget "Marcar" ou Sofia): AGENDADO sem data é pendência da Conferência
  agendado: { para: ETAPA.AGENDADO, rotulo: 'Marcou a consulta', pede: [CAMPOS_SYNC.DATA_CONSULTA], futura: CAMPOS_SYNC.DATA_CONSULTA, sugere: ['¤ Pagamento antecipado'] },
  remarcou: { para: ETAPA.AGENDADO, rotulo: 'Remarcou a consulta', pede: [CAMPOS_SYNC.DATA_CONSULTA], futura: CAMPOS_SYNC.DATA_CONSULTA },
  novaConsulta: { para: ETAPA.AGENDADO, rotulo: 'Marcou uma nova consulta', pede: [CAMPOS_SYNC.DATA_CONSULTA], futura: CAMPOS_SYNC.DATA_CONSULTA },
  espera: { para: ETAPA.ESPERA, rotulo: 'Quer, mas depois', pede: [CAMPO.MOTIVO_ESPERA, CAMPO.RETOMAR_EM] },
  desmarcou: { para: ETAPA.ESPERA, rotulo: 'Desmarcou e quer remarcar depois', pede: [CAMPO.MOTIVO_ESPERA, CAMPO.RETOMAR_EM], dica: DESMARQUE_NA_FRANQUIA },
  compareceu: { para: ETAPA.COMPARECEU, rotulo: 'Veio à consulta' },
  faltou: { para: ETAPA.NAO_COMPARECEU, rotulo: 'Faltou à consulta', sugere: ['⊘ Motivo da falta'] },
  negociacao: { para: ETAPA.NEGOCIACAO, rotulo: 'Ainda está decidindo o tratamento', sugere: ['⊘ Motivo de não fechamento do tratamento'] },
  perdido: { para: ETAPA.PERDIDO, rotulo: 'Não vai seguir', pede: [CAMPO.MOTIVO_NAO_AGENDAMENTO] },
  desistiu: { para: ETAPA.PERDIDO, rotulo: 'Desistiu da consulta', pede: [CAMPO.MOTIVO_NAO_AGENDAMENTO], dica: DESMARQUE_NA_FRANQUIA },
  perdidoDepoisDaConsulta: { para: ETAPA.PERDIDO, rotulo: 'Não vai fazer o tratamento', pede: ['⊘ Motivo de não fechamento do tratamento'] },
} as const satisfies Record<string, SaidaDaEtapa>;

/**
 * As saídas de cada etapa do COMERCIAL, na ordem em que aparecem. Etapa que não está aqui (RETORNO
 * PÓS-TRATAMENTO, GANHO e o funil TRATAMENTO) não tem saída pela Ponte: é da franquia e dos robôs.
 */
export const SAIDAS_POR_ETAPA: Readonly<Record<string, readonly SaidaDaEtapa[]>> = Object.freeze({
  [ETAPA.QUALIFICACAO]: [S.agendado, S.espera, S.perdido],
  [ETAPA.ESPERA]: [S.voltou, S.agendado, S.perdido],
  [ETAPA.CONFERIR]: [S.agendado, S.perdido],
  [ETAPA.AGENDADO]: [S.compareceu, S.faltou, S.desmarcou, S.desistiu],
  [ETAPA.NAO_COMPARECEU]: [S.remarcou, S.espera, S.perdido],
  [ETAPA.COMPARECEU]: [S.negociacao, S.perdidoDepoisDaConsulta],
  [ETAPA.NEGOCIACAO]: [S.novaConsulta, S.perdidoDepoisDaConsulta],
  [ETAPA.PERDIDO]: [S.voltou, S.espera],
});

/** A etapa de entrada ("Incoming leads", tipo 1): começar a atender, ou as mesmas da qualificação. */
const SAIDAS_DA_ENTRADA: readonly SaidaDaEtapa[] = [S.comecar, S.agendado, S.espera, S.perdido];

/** As etapas do COMERCIAL que a SDR pode escolher como destino. GANHO nunca (é da franquia). */
export const ETAPAS_DA_SDR: readonly string[] = Object.freeze([
  ETAPA.QUALIFICACAO,
  ETAPA.ESPERA,
  ETAPA.AGENDADO,
  ETAPA.NAO_COMPARECEU,
  ETAPA.COMPARECEU,
  ETAPA.NEGOCIACAO,
  ETAPA.PERDIDO,
]);

/** Todos os nomes que aparecem nas listas da SDR (por etapa e nas saídas): são os campos que a Ponte grava. */
const NOMES_DA_SDR: readonly string[] = Object.freeze([
  ...Object.values(CAMPOS_DA_SDR_POR_ETAPA).flat(),
  ...Object.values(SAIDAS_POR_ETAPA)
    .flat()
    .flatMap((s) => [...(s.pede ?? []), ...(s.sugere ?? [])]),
]);

const naLista = (lista: readonly string[], nome: string) => lista.some((n) => casaNome(nome, n));

// ── as etapas ──

export interface EtapaDoGuia {
  id: number;
  name: string;
  sort?: number;
  type?: number;
}

export interface FunilDoGuia {
  id: number;
  name: string;
  is_main?: boolean;
  is_archive?: boolean;
  statuses: ReadonlyArray<EtapaDoGuia>;
}

/**
 * As etapas cujo obrigatório vale para ENTRAR em `statusId` deste funil (a regra cumulativa da tela do Kommo):
 * as etapas de antes (pela ordem) e ela; GANHO = o funil inteiro menos PERDIDO; PERDIDO = só ele.
 */
export function etapasQueCobram(funil: FunilDoGuia, statusId: number): Set<number> {
  if (statusId === PERDIDO) return new Set([PERDIDO]);
  const alvo = funil.statuses.find((s) => s.id === statusId);
  if (!alvo) return new Set();
  if (statusId === GANHO) return new Set(funil.statuses.filter((s) => s.id !== PERDIDO).map((s) => s.id));
  const limite = alvo.sort ?? 0;
  return new Set(funil.statuses.filter((s) => s.id !== GANHO && s.id !== PERDIDO && (s.sort ?? 0) <= limite).map((s) => s.id));
}

/** Os campos que o Kommo exige para entrar em `statusId` (cumulativo). Cabeçalho nunca. */
export function obrigatoriosParaEntrar<T extends DefinicaoDeCampo>(defs: ReadonlyArray<T>, funil: FunilDoGuia, statusId: number): T[] {
  const cobram = etapasQueCobram(funil, statusId);
  return defs.filter((d) => !ehCabecalho(d.name) && (d.required_statuses ?? []).some((r) => r.pipeline_id === funil.id && cobram.has(r.status_id)));
}

const escondidoEm = (d: DefinicaoDeCampo, funilId: number, statusId: number) =>
  (d.hidden_statuses ?? []).some((h) => h.pipeline_id === funilId && h.status_id === statusId);

/** O funil COMERCIAL da conta: pelo nome; senão o principal (como a barrinha do cartão). */
export function funilComercialDoGuia<T extends FunilDoGuia>(funis: ReadonlyArray<T>): T | null {
  const vivos = funis.filter((f) => !f.is_archive);
  return vivos.find((f) => mesmoNome(f.name, 'COMERCIAL')) ?? vivos.find((f) => normalizarNome(f.name).includes('comercial')) ?? vivos.find((f) => f.is_main) ?? null;
}

const ehEntrada = (e: EtapaDoGuia) => e.type === 1 || ehEtapaDeEntrada(e.name);

/** As saídas configuradas para uma etapa do COMERCIAL (pelo nome). */
export function saidasDaEtapa(etapa: EtapaDoGuia): readonly SaidaDaEtapa[] {
  if (etapa.id === GANHO) return [];
  if (etapa.id === PERDIDO) return SAIDAS_POR_ETAPA[ETAPA.PERDIDO];
  if (ehEntrada(etapa)) return SAIDAS_DA_ENTRADA;
  const k = Object.keys(SAIDAS_POR_ETAPA).find((n) => mesmoNome(etapa.name, n));
  return k ? SAIDAS_POR_ETAPA[k] : [];
}

/** A etapa do funil com este nome. PERDIDO e GANHO pelo id (o nome muda: "GANHO / CONCLUIDO", "PERDIDO"…). */
export function etapaPorNome(funil: FunilDoGuia, nome: string): EtapaDoGuia | null {
  if (mesmoNome(nome, ETAPA.PERDIDO)) return funil.statuses.find((s) => s.id === PERDIDO) ?? null;
  if (mesmoNome(nome, ETAPA.GANHO)) return funil.statuses.find((s) => s.id === GANHO) ?? null;
  return funil.statuses.find((s) => s.id !== GANHO && s.id !== PERDIDO && mesmoNome(s.name, nome)) ?? null;
}

/** A etapa é destino que a SDR pode escolher? COMERCIAL, pelo nome, nunca GANHO nem entrada. */
export function ehEtapaDaSdr(etapa: EtapaDoGuia): boolean {
  if (etapa.id === GANHO || ehEntrada(etapa)) return false;
  if (etapa.id === PERDIDO) return true;
  return ETAPAS_DA_SDR.some((n) => n !== ETAPA.PERDIDO && mesmoNome(etapa.name, n));
}

/** Os campos da SDR de uma etapa (pelo nome; PERDIDO e GANHO pelo id, ALTA e CANCELADO são 142/143 do TRATAMENTO). */
function nomesDaSdrNaEtapa(etapa: EtapaDoGuia, funil: FunilDoGuia, comercialId: number | null): readonly string[] {
  const doComercial = funil.id === comercialId;
  if (etapa.id === GANHO) return CAMPOS_DA_SDR_POR_ETAPA[doComercial ? ETAPA.GANHO : ETAPA.ALTA];
  if (etapa.id === PERDIDO) return CAMPOS_DA_SDR_POR_ETAPA[doComercial ? ETAPA.PERDIDO : ETAPA.CANCELADO];
  if (ehEntrada(etapa)) return doComercial ? CAMPOS_DA_SDR_POR_ETAPA[ETAPA.QUALIFICACAO] : [];
  const k = Object.keys(CAMPOS_DA_SDR_POR_ETAPA).find((n) => mesmoNome(etapa.name, n));
  return k ? CAMPOS_DA_SDR_POR_ETAPA[k] : [];
}

// ── quem preenche ──

export type Quem = 'sdr' | 'franquia' | 'robo';

/** O campo é exigido em alguma etapa de algum funil da conta? (a tela obriga a SDR a preencher) */
const exigidoNaConta = (d: DefinicaoDeCampo) => (d.required_statuses ?? []).length > 0;

/**
 * Quem preenche o campo. Os da franquia, da franquia (mesmo os "Apenas API", para o guia dizer "marque a consulta");
 * "Apenas API", ids (⚙), ligação (☎ — tem rota própria), aviso da pausa (⏸) e os automáticos, do robô; os do anúncio,
 * do robô a não ser que a conta os exija. O resto, da SDR.
 */
export function quemPreenche(d: DefinicaoDeCampo): Quem {
  const nome = String(d.name ?? '').trim();
  if (naLista(CAMPOS_DA_FRANQUIA, nome)) return 'franquia';
  if (d.is_api_only || /^[⚙☎⏸]/u.test(nome) || d.type === 'tracking_data' || naLista(CAMPOS_AUTOMATICOS, nome)) return 'robo';
  if (naLista(CAMPOS_DO_ANUNCIO, nome)) return exigidoNaConta(d) ? 'sdr' : 'robo';
  return 'sdr';
}

/** Como o painel pede o valor. `outro` = a Ponte não grava este tipo (url, caixinha, lista múltipla…). */
export type TipoDaEntrada = 'texto' | 'texto-longo' | 'numero' | 'dinheiro' | 'data' | 'lista' | 'outro';

export function tipoDaEntrada(tipo: string): TipoDaEntrada {
  switch (tipo) {
    case 'text':
    case 'streetaddress':
      return 'texto';
    case 'textarea':
      return 'texto-longo';
    case 'numeric':
      return 'numero';
    case 'monetary':
      return 'dinheiro';
    case 'date':
    case 'date_time':
    case 'birthday':
      return 'data';
    case 'select':
    case 'radiobutton':
      return 'lista';
    default:
      return 'outro';
  }
}

/**
 * A Ponte pode gravar este campo? Nunca cabeçalho; só campo da SDR, de tipo que a Ponte sabe gravar, e que seja da
 * lista da SDR (por etapa ou nas saídas), o ⌂ Unidade de atendimento, ou exigido pela conta em alguma etapa.
 */
export function campoDaSdr(d: DefinicaoDeCampo): boolean {
  if (ehCabecalho(d.name) || quemPreenche(d) !== 'sdr' || tipoDaEntrada(d.type) === 'outro') return false;
  return naLista(NOMES_DA_SDR, d.name) || mesmoNome(d.name, CAMPO_UNIDADE) || exigidoNaConta(d);
}

// ── os valores do cartão ──

export interface ValorDoCampo {
  field_id: number;
  values?: ReadonlyArray<{ value?: unknown; enum_id?: number | null }> | null;
}

export interface CartaoDoGuia {
  id: number;
  name?: string | null;
  status_id: number;
  pipeline_id: number;
  custom_fields_values?: ReadonlyArray<ValorDoCampo> | null;
  _embedded?: { tags?: ReadonlyArray<{ name: string }> | null } | null;
}

const valoresDe = (lead: CartaoDoGuia, id: number) => (lead.custom_fields_values ?? []).find((c) => c.field_id === id)?.values ?? [];

/** O campo está vazio no cartão? (o Kommo nem manda o campo vazio) */
export function vazioNoCartao(lead: CartaoDoGuia, id: number): boolean {
  return !valoresDe(lead, id).some((v) => v.enum_id != null || (v.value != null && String(v.value).trim() !== ''));
}

const FORMATO_DINHEIRO = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
/** "R$ 250,00" (com espaço comum: o Intl põe um espaço que não quebra, e a nota fica estranha copiada). */
const DINHEIRO = { format: (n: number) => FORMATO_DINHEIRO.format(n).replace(/\u00a0/g, ' ') };

/** O valor de um campo do jeito que a SDR lê: data dd/mm/aaaa no fuso, dinheiro "R$ 250,00", a opção da lista. */
export function textoDoValor(d: DefinicaoDeCampo, vals: ReadonlyArray<{ value?: unknown; enum_id?: number | null }>, tz: string): string | null {
  const v = vals[0];
  if (!v) return null;
  const tipo = tipoDaEntrada(d.type);
  if (tipo === 'lista') {
    const opcao = v.enum_id != null ? (d.enums ?? []).find((e) => e.id === v.enum_id)?.value : null;
    return opcao ?? (v.value != null && String(v.value).trim() ? String(v.value) : null);
  }
  if (v.value == null || String(v.value).trim() === '') return null;
  if (tipo === 'data') {
    const n = Number(v.value);
    if (!Number.isFinite(n) || n <= 0) return String(v.value);
    return dataBRNoFuso((n > 1e11 ? n : n * 1000), tz);
  }
  if (tipo === 'dinheiro') {
    const n = Number(v.value);
    return Number.isFinite(n) ? DINHEIRO.format(n) : String(v.value);
  }
  if (d.type === 'multiselect') return vals.map((x) => (x.enum_id != null ? (d.enums ?? []).find((e) => e.id === x.enum_id)?.value : x.value)).filter(Boolean).join(', ');
  return String(v.value);
}

// ── o que o guia devolve ──

export interface CampoDoGuia {
  id: number;
  nome: string;
  tipo: TipoDaEntrada;
  opcoes?: Array<{ id: number; valor: string }>;
  /** O Kommo exige para entrar (na etapa atual ou no destino) — ou a Ponte pede antes de mover. */
  obrigatorio: boolean;
  /** A Ponte grava este campo. Falso = quem preenche é a franquia ou um robô (o guia diz quem). */
  editavel: boolean;
  quem: Quem;
  /** Quando não dá para gravar pela Ponte: o que fazer. */
  dica?: string;
  /** Como está agora no cartão (texto), ou null. */
  valor: string | null;
}

export interface SaidaDoGuia {
  statusId: number;
  nome: string;
  rotulo: string;
  /** O que falta para mover (obrigatórios do Kommo + o que a Ponte pede). Vazio = pode mover. */
  faltam: CampoDoGuia[];
  /** Aparecem para preencher junto, sem travar. */
  sugere: CampoDoGuia[];
  /** Falta algo que a Ponte NÃO preenche (da franquia ou de robô): o painel não deixa mover e diz o porquê. */
  bloqueio: string | null;
  /** As mensagens conhecidas que os robôs desta etapa mandam (pode vir vazio: o aviso geral vale sempre). */
  mensagens: string[];
  dicas: string[];
}

export interface UnidadeDoGuia {
  campoId: number;
  nome: string;
  opcoes: Array<{ id: number; valor: string }>;
  valor: string | null;
  /** O campo está vazio: escolher a unidade é o PRIMEIRO passo, e nada mais é gravado nem movido antes. */
  precisa: boolean;
}

export interface GuiaDoCartao {
  leadId: number;
  nome: string | null;
  funil: string | null;
  etapa: string | null;
  statusId: number;
  pipelineId: number;
  noComercial: boolean;
  /** O "⚠ Pendência do cartão" (oculto no Kommo). */
  pendencia: string | null;
  unidade: UnidadeDoGuia | null;
  /** O que falta nesta etapa (obrigatórios + os da SDR), vazio no cartão. */
  faltam: CampoDoGuia[];
  saidas: SaidaDoGuia[];
  /** Por que não há saída (etapa da franquia e dos robôs), quando não há. */
  semSaidas: string | null;
  avisoDosRobos: string;
}

/**
 * Como marcar a consulta (0.5.1, a regra do João): paciente NOVO se cadastra e marca pelo widget "Assistente do cartão"
 * do Kommo ("Cadastrar e marcar na franquia"), NUNCA direto na franquia; paciente já cadastrado marca na franquia ou pelo
 * widget. Sem falar da Sofia: a dica é do que a ATENDENTE faz, e o mesmo guia serve à unidade sem IA (Petrópolis, Caxias).
 */
export const COMO_MARCAR_A_CONSULTA =
  'Paciente novo: pelo widget "Assistente do cartão" do Kommo, em "Cadastrar e marcar na franquia" — nunca direto na franquia. ' +
  'Já cadastrado: na franquia ou pelo widget.';

const DICA_DA_FRANQUIA: Readonly<Record<string, string>> = Object.freeze({
  [normalizarNome(CAMPOS_SYNC.DATA_CONSULTA)]: `Marque a consulta primeiro: a data entra sozinha no cartão. ${COMO_MARCAR_A_CONSULTA}`,
});

function campoDoGuia(d: DefinicaoDeCampo, lead: CartaoDoGuia, tz: string, obrigatorio: boolean, dicaFixa?: string): CampoDoGuia {
  const quem = quemPreenche(d);
  const editavel = campoDaSdr(d);
  const tipo = tipoDaEntrada(d.type);
  let dica: string | undefined = dicaFixa;
  if (!editavel && !dica) {
    dica = quem === 'franquia'
      ? DICA_DA_FRANQUIA[normalizarNome(d.name)] ?? 'Quem preenche é a franquia: confira o cadastro lá.'
      : quem === 'robo'
        ? 'Quem preenche é o sistema: a Ponte não mexe neste campo.'
        : 'Preencha este campo no Kommo (a Ponte não grava este tipo de campo).';
  }
  return {
    id: d.id,
    nome: d.name.trim(),
    tipo,
    ...(tipo === 'lista' ? { opcoes: (d.enums ?? []).map((e) => ({ id: e.id, valor: e.value })) } : {}),
    obrigatorio,
    editavel,
    quem,
    ...(dica ? { dica } : {}),
    valor: textoDoValor(d, valoresDe(lead, d.id), tz),
  };
}

/** Ordena como no cartão (pela posição do campo na conta). */
const naOrdem = <T extends DefinicaoDeCampo>(l: T[]) => l.slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);

function unicos<T extends { id: number }>(l: T[]): T[] {
  const vistos = new Set<number>();
  return l.filter((x) => (vistos.has(x.id) ? false : (vistos.add(x.id), true)));
}

/** O que bloqueia mover: campos que faltam e a Ponte não preenche. */
function bloqueioDe(faltam: CampoDoGuia[]): string | null {
  const presos = faltam.filter((c) => !c.editavel);
  if (!presos.length) return null;
  return 'Ainda não dá para mover: ' + presos.map((c) => `${c.nome} — ${c.dica ?? 'preencha no Kommo'}`).join(' ');
}

export interface EntradaDoGuia {
  lead: CartaoDoGuia;
  defs: ReadonlyArray<DefinicaoDeCampo>;
  funis: ReadonlyArray<FunilDoGuia>;
  tz: string;
  /** As mensagens conhecidas por etapa (`mensagensDaUnidade`). */
  mensagens?: ReadonlyMap<string, readonly string[]>;
  /** O relógio (o teste fixa). */
  agora?: Date;
}

/** A unidade de atendimento (Petrópolis × Caxias), quando a conta tem o campo. */
export function unidadeDoCartao(defs: ReadonlyArray<DefinicaoDeCampo>, lead: CartaoDoGuia, tz: string): UnidadeDoGuia | null {
  const d = campoPorNome(defs, CAMPO_UNIDADE);
  if (!d) return null;
  const valor = textoDoValor(d, valoresDe(lead, d.id), tz);
  return { campoId: d.id, nome: d.name.trim(), opcoes: (d.enums ?? []).map((e) => ({ id: e.id, valor: e.value })), valor, precisa: !valor };
}

/** Os campos que faltam para entrar em `destino` (obrigatórios cumulativos + o que a saída pede), vazios no cartão. */
function faltamParaEntrar(defs: ReadonlyArray<DefinicaoDeCampo>, funil: FunilDoGuia, destino: EtapaDoGuia, saida: SaidaDaEtapa | null, lead: CartaoDoGuia) {
  const exigidos = obrigatoriosParaEntrar(defs, funil, destino.id);
  const pedidos = (saida?.pede ?? []).map((n) => campoPorNome(defs, n)).filter((d): d is DefinicaoDeCampo => !!d);
  return naOrdem(unicos([...exigidos, ...pedidos])).filter((d) => vazioNoCartao(lead, d.id));
}

/**
 * A data que a saída exige no futuro (a ◷ Data da Consulta para ir a AGENDADO) está no PASSADO? Devolve o campo, para
 * travar: voltar para AGENDADO com a consulta de antes de ontem deixaria o cartão errado (e os robôs de lembrete
 * mudos). Vazia não conta aqui (o `pede` já cobra).
 */
function dataNoPassado(defs: ReadonlyArray<DefinicaoDeCampo>, saida: SaidaDaEtapa | null, lead: CartaoDoGuia, tz: string, agora: Date): DefinicaoDeCampo | null {
  if (!saida?.futura) return null;
  const d = campoPorNome(defs, saida.futura);
  if (!d || vazioNoCartao(lead, d.id)) return null;
  const n = Number(valoresDe(lead, d.id)[0]?.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return dataLocalISO(new Date(n > 1e11 ? n : n * 1000), tz) < dataLocalISO(agora, tz) ? d : null;
}

function dicaDaDataNoPassado(d: DefinicaoDeCampo, lead: CartaoDoGuia, tz: string): string {
  return `A data do cartão (${textoDoValor(d, valoresDe(lead, d.id), tz) ?? '?'}) já passou: marque a nova consulta primeiro, e a data nova entra sozinha. ${COMO_MARCAR_A_CONSULTA}`;
}

/** Os dois campos ⊘ em que fica o motivo do PERDIDO (antes e depois da consulta). */
const CAMPOS_DO_MOTIVO = [CAMPO.MOTIVO_NAO_AGENDAMENTO, '⊘ Motivo de não fechamento do tratamento'];

/** A ETIQUETA_SEM_MENSAGEM está no cartão? */
const temSemMensagem = (lead: CartaoDoGuia) => (lead._embedded?.tags ?? []).some((t) => mesmoNome(t?.name, ETIQUETA_SEM_MENSAGEM));

/** Monta o guia do cartão: pendência, unidade, o que falta nesta etapa e as saídas. Puro. */
export function montarGuia(e: EntradaDoGuia): GuiaDoCartao {
  const { lead, defs, tz } = e;
  const funil = e.funis.find((f) => f.id === lead.pipeline_id) ?? null;
  const comercial = funilComercialDoGuia(e.funis);
  const etapa = funil?.statuses.find((s) => s.id === lead.status_id) ?? null;
  const noComercial = !!funil && !!comercial && funil.id === comercial.id;
  const pend = campoPorNome(defs, CAMPO_PENDENCIA);
  const pendencia = pend ? textoDoValor(pend, valoresDe(lead, pend.id), tz) : null;
  const unidade = unidadeDoCartao(defs, lead, tz);

  // nesta etapa: os obrigatórios para estar aqui (cumulativos) + os da SDR que não estão escondidos aqui
  let faltam: CampoDoGuia[] = [];
  if (funil && etapa) {
    const exigidos = obrigatoriosParaEntrar(defs, funil, etapa.id);
    const daSdr = nomesDaSdrNaEtapa(etapa, funil, comercial?.id ?? null)
      .map((n) => campoPorNome(defs, n))
      .filter((d): d is DefinicaoDeCampo => !!d && !escondidoEm(d, funil.id, etapa.id) && campoDaSdr(d));
    const ids = new Set(exigidos.map((d) => d.id));
    // PERDIDO depois da consulta tem o motivo no "⊘ Motivo de não fechamento": com um dos dois ⊘ preenchido, o outro
    // não é pendência (a não ser que o Kommo o exija)
    const motivos = CAMPOS_DO_MOTIVO.map((n) => campoPorNome(defs, n)).filter((d): d is DefinicaoDeCampo => !!d);
    const temMotivo = etapa.id === PERDIDO && noComercial && motivos.some((d) => !vazioNoCartao(lead, d.id));
    faltam = naOrdem(unicos([...exigidos, ...daSdr]))
      .filter((d) => vazioNoCartao(lead, d.id) && (ids.has(d.id) || quemPreenche(d) === 'sdr'))
      .filter((d) => !(temMotivo && !ids.has(d.id) && motivos.some((m) => m.id === d.id)))
      .map((d) => campoDoGuia(d, lead, tz, ids.has(d.id)));
  }

  let saidas: SaidaDoGuia[] = [];
  let semSaidas: string | null = null;
  if (!funil || !etapa) semSaidas = 'Não achei a etapa deste cartão no Kommo.';
  else if (!noComercial) semSaidas = `O funil ${funil.name} é da franquia e dos robôs: a Ponte não move cartão nele.`;
  else {
    for (const s of saidasDaEtapa(etapa)) {
      const destino = etapaPorNome(funil, s.para);
      if (!destino || destino.id === etapa.id || !ehEtapaDaSdr(destino)) continue;
      const faltamAqui = faltamParaEntrar(defs, funil, destino, s, lead);
      const exigidos = new Set(faltamAqui.map((d) => d.id));
      const sugere = (s.sugere ?? [])
        .map((n) => campoPorNome(defs, n))
        .filter((d): d is DefinicaoDeCampo => !!d && !exigidos.has(d.id) && campoDaSdr(d) && vazioNoCartao(lead, d.id));
      const camposQueFaltam = faltamAqui.map((d) => campoDoGuia(d, lead, tz, true));
      const passou = dataNoPassado(defs, s, lead, tz, e.agora ?? new Date());
      if (passou) camposQueFaltam.push({ ...campoDoGuia(passou, lead, tz, true, dicaDaDataNoPassado(passou, lead, tz)), editavel: false });
      const dicas: string[] = s.dica ? [s.dica] : [];
      if (destino.id === PERDIDO && !temSemMensagem(lead)) {
        dicas.push(
          `Se o paciente pediu para não receber mais mensagens, ponha antes a etiqueta ${ETIQUETA_SEM_MENSAGEM}: sem ela, os robôs do PERDIDO podem mandar mensagens de retomada.`,
        );
      }
      saidas.push({
        statusId: destino.id,
        nome: destino.name,
        rotulo: s.rotulo,
        faltam: camposQueFaltam,
        sugere: naOrdem(sugere).map((d) => campoDoGuia(d, lead, tz, false)),
        bloqueio: bloqueioDe(camposQueFaltam),
        mensagens: [...(e.mensagens?.get(normalizarNome(destino.id === PERDIDO ? ETAPA.PERDIDO : destino.name)) ?? [])],
        dicas,
      });
    }
    if (!saidas.length) {
      semSaidas = etapa.id === GANHO
        ? 'GANHO é da franquia e dos robôs: a Ponte não move cartão daqui.'
        : `A etapa ${etapa.name} é da franquia e dos robôs: a Ponte não move cartão daqui.`;
    }
  }
  // dedupe por destino (a mesma etapa pode aparecer em duas saídas da lista)
  saidas = saidas.filter((s, i) => saidas.findIndex((x) => x.statusId === s.statusId) === i);

  return {
    leadId: lead.id,
    nome: lead.name ?? null,
    funil: funil?.name ?? null,
    etapa: etapa?.name ?? null,
    statusId: lead.status_id,
    pipelineId: lead.pipeline_id,
    noComercial,
    pendencia,
    unidade,
    faltam,
    saidas,
    semSaidas,
    avisoDosRobos: AVISO_DOS_ROBOS,
  };
}

// ── as mensagens conhecidas de cada etapa ──

/**
 * O que os robôs de cada etapa mandam ao paciente, por CONTA do Kommo (os robôs são da conta). Açailândia: a régua
 * da Serra no ar desde 07/10/2026 (`video-tutorial/v3/mensagens_por_etapa.json` e `gatilhos_por_etapa.json`), só os
 * gatilhos de ETAPA e de DATA — os de etiqueta (▶) a Ponte já pergunta antes de pôr. Conta nova: acrescente aqui ou
 * na variável `PONTE_MENSAGENS_DA_ETAPA_<SLUG>` (JSON: `{"AGENDADO": ["…"], "PERDIDO": ["…"]}`), que substitui as
 * etapas que listar.
 */
export const MENSAGENS_DA_ETAPA: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  doutorherniaacailandia: {
    [ETAPA.QUALIFICACAO]: [
      'Se o paciente passar 24 h sem responder, o robô de lembrete entra em ação.',
      'Qualificação Quente e 3 h sem resposta: outro robô entra em ação.',
    ],
    [ETAPA.ESPERA]: [
      'No dia do ◷ Retomar em (às 9 h), a mensagem do ⊘ Motivo da espera: exames, viagem, "vai decidir" ou financeiro ("Você comentou que…").',
      'Três dias depois, se não respondeu: "Passando mais uma vez, da Doutor Hérnia Açailândia…".',
    ],
    [ETAPA.AGENDADO]: [
      'Ao entrar, se ¤ Pagamento antecipado = Sim e ainda não pagou: "A sua consulta está pré-agendada… Quer que eu envie os dados para pagamento?" — e, 3 h depois, o lembrete do pagamento.',
      '3 h antes da consulta: "A sua consulta de hoje está marcada para…"; 1 h antes: o que levar (documento, exames, roupa confortável).',
      '2 dias depois da consulta, se a situação for Não compareceu: "O seu horário de consulta segue disponível para remarcação…".',
    ],
    [ETAPA.NAO_COMPARECEU]: [
      'Quando a situação da consulta vira Não compareceu: "Você não conseguiu comparecer à consulta de hoje…".',
      '2 dias depois da consulta: "O seu horário de consulta segue disponível para remarcação…".',
    ],
    [ETAPA.COMPARECEU]: [
      '1 dia depois da consulta (se atendido): "Foi bom te receber ontem…".',
      '4, 7 e 30 dias depois da consulta: mensagens sobre o plano indicado; a de 7 dias avisa que vai encerrar o acompanhamento.',
    ],
    [ETAPA.NEGOCIACAO]: [
      '4, 7 e 30 dias depois da consulta (se atendido): mensagens sobre o plano indicado; a de 7 dias avisa que vai encerrar o acompanhamento.',
    ],
    [ETAPA.PERDIDO]: [
      '2 dias depois: "Fiquei sem a sua resposta… Como está a sua dor hoje?"; 4 dias: o convite para a consulta; 5 dias: avisa que o atendimento será encerrado.',
      `Não saem para quem tem a etiqueta ${ETIQUETA_SEM_MENSAGEM}.`,
    ],
  },
});

const variavelDaUnidade = (prefixo: string, slug: string) => `${prefixo}_${String(slug).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/**
 * As mensagens conhecidas por etapa (chave = `normalizarNome` da etapa) para a unidade: as da conta, com a variável
 * `PONTE_MENSAGENS_DA_ETAPA_<SLUG>` por cima. JSON inválido na variável é ignorado (vale o que há no código).
 */
export function mensagensDaUnidade(
  unit: { slug: string; kommoSubdomain: string | null },
  ambiente: Record<string, string | undefined> = process.env,
): Map<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  const daConta = MENSAGENS_DA_ETAPA[String(unit.kommoSubdomain ?? '').trim().toLowerCase()] ?? {};
  for (const [etapa, l] of Object.entries(daConta)) m.set(normalizarNome(etapa), l);
  const bruto = ambiente[variavelDaUnidade('PONTE_MENSAGENS_DA_ETAPA', unit.slug)];
  if (bruto) {
    try {
      const j = JSON.parse(bruto) as unknown;
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        for (const [etapa, v] of Object.entries(j as Record<string, unknown>)) {
          const l = (Array.isArray(v) ? v : [v]).map((x) => textoCurto(x, 400)).filter((x): x is string => !!x).slice(0, 8);
          m.set(normalizarNome(etapa), l);
        }
      }
    } catch {
      // variável mal escrita: fica o que está no código
    }
  }
  return m;
}

// ── os pedidos ──

export interface CampoPedido {
  id: number;
  valor: unknown;
}

export interface PedidoDeCampos {
  leadId: number;
  campos: CampoPedido[];
  por: string | null;
}

export interface PedidoDeMover extends PedidoDeCampos {
  /** A etapa em que o painel viu o cartão: se mudou nesse meio-tempo, a Ponte não move. */
  de: number;
  para: number;
  /** A SDR confirmou (o painel mostrou o que vai gravar, a mudança e o aviso dos robôs). */
  confirmado: boolean;
}

/** No máximo quantos campos num pedido (o guia mostra poucos por vez). */
const MAX_CAMPOS = 15;

function lerCampos(v: unknown): CampoPedido[] | null {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_CAMPOS) return null;
  const out: CampoPedido[] = [];
  for (const c of v) {
    const id = leadIdDoPedido((c as { id?: unknown } | null)?.id);
    if (!id) return null;
    if (out.some((x) => x.id === id)) return null; // o mesmo campo duas vezes: qual vale?
    out.push({ id, valor: (c as { valor?: unknown }).valor });
  }
  return out;
}

/** `POST …/ponte/campos` → `{ leadId, campos: [{ id, valor }], por? }`. */
export function lerPedidoDeCampos(corpo: unknown): Lido<PedidoDeCampos> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  const campos = lerCampos(b.campos);
  if (!campos) return { ok: false, erro: 'campos inválidos' };
  if (!campos.length) return { ok: false, erro: 'nenhum campo para gravar' };
  return { ok: true, pedido: { leadId, campos, por: textoCurto(b.por, 80) } };
}

/** `POST …/ponte/mover` → `{ leadId, de, para, campos?, por?, confirmado }`. */
export function lerPedidoDeMover(corpo: unknown): Lido<PedidoDeMover> {
  const b = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  const leadId = leadIdDoPedido(b.leadId);
  if (!leadId) return { ok: false, erro: 'lead inválido' };
  const de = leadIdDoPedido(b.de);
  const para = leadIdDoPedido(b.para);
  if (!de || !para) return { ok: false, erro: 'etapa inválida' };
  const campos = lerCampos(b.campos);
  if (!campos) return { ok: false, erro: 'campos inválidos' };
  return { ok: true, pedido: { leadId, de, para, campos, por: textoCurto(b.por, 80), confirmado: b.confirmado === true } };
}

// ── o valor que vai para o Kommo ──

export interface Gravacao {
  field_id: number;
  values: Array<Record<string, unknown>>;
  nome: string;
  /** Como a SDR lê o valor (para a prévia, a nota e a resposta). */
  texto: string;
}

/** Meia-noite do dia no fuso da unidade (o Kommo guarda campo `date` assim: é dele que o robô conta "9 h depois"). */
export function meiaNoiteNoFuso(isoDia: string, tz: string): number {
  const [a, m, d] = isoDia.split('-').map(Number);
  const candidato = Date.UTC(a, m - 1, d, 0, 0, 0);
  return Math.floor((candidato - offsetMinutosNoFuso(new Date(candidato), tz) * 60_000) / 1000);
}

/** Tira os caracteres que o Kommo não guarda (fora do plano básico: a maioria dos emojis). */
const semAstral = (s: string) => s.replace(/[\u{10000}-\u{10FFFF}]/gu, '').replace(/[️‍]/g, '');

/** Número do jeito que a SDR digita: "250", "1.250,50", "R$ 90". */
export function numeroDigitado(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const limpo = v.replace(/R\$/gi, '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(limpo)) return null;
  const n = Number(limpo);
  return Number.isFinite(n) ? n : null;
}

/** O valor pedido, já no formato do Kommo, ou o erro (para a SDR). */
export function valorParaOKommo(d: DefinicaoDeCampo, bruto: unknown, tz: string): { ok: true; values: Array<Record<string, unknown>>; texto: string } | { ok: false; erro: string } {
  const nome = d.name.trim();
  switch (tipoDaEntrada(d.type)) {
    case 'texto':
    case 'texto-longo': {
      const max = d.type === 'textarea' ? 4000 : 250;
      const s = typeof bruto === 'string' ? semAstral(bruto).replace(/\r\n?/g, '\n').trim() : '';
      if (!s) return { ok: false, erro: `${nome}: escreva o texto` };
      if (s.length > max) return { ok: false, erro: `${nome}: o texto passou de ${max} letras` };
      return { ok: true, values: [{ value: s }], texto: s };
    }
    case 'numero':
    case 'dinheiro': {
      const n = numeroDigitado(bruto);
      if (n === null || n < 0) return { ok: false, erro: `${nome}: digite só o número` };
      return { ok: true, values: [{ value: n }], texto: d.type === 'monetary' ? DINHEIRO.format(n) : String(n).replace('.', ',') };
    }
    case 'data': {
      const s = typeof bruto === 'string' ? bruto.trim() : '';
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      const ok = m && Number(m[1]) >= 2000 && Number(m[1]) <= 2100 && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
      if (!ok) return { ok: false, erro: `${nome}: escolha a data no calendário` };
      return { ok: true, values: [{ value: meiaNoiteNoFuso(s, tz) }], texto: `${m![3]}/${m![2]}/${m![1]}` };
    }
    case 'lista': {
      const id = leadIdDoPedido(bruto);
      const opcao = id ? (d.enums ?? []).find((e) => e.id === id) : null;
      if (!opcao) return { ok: false, erro: `${nome}: escolha uma das opções` };
      return { ok: true, values: [{ enum_id: opcao.id }], texto: opcao.value };
    }
    default:
      return { ok: false, erro: `${nome}: a Ponte não grava este tipo de campo (preencha no Kommo)` };
  }
}

/** O valor que está no cartão é o mesmo que se quer gravar? (data: o mesmo dia no fuso) */
export function mesmoValor(d: DefinicaoDeCampo, lead: CartaoDoGuia, values: ReadonlyArray<Record<string, unknown>>, tz: string): boolean {
  const atual = valoresDe(lead, d.id)[0];
  const novo = values[0];
  if (!atual || !novo) return false;
  switch (tipoDaEntrada(d.type)) {
    case 'lista':
      return atual.enum_id != null && atual.enum_id === novo.enum_id;
    case 'data': {
      const a = Number(atual.value);
      const n = Number(novo.value);
      if (!Number.isFinite(a) || !Number.isFinite(n)) return false;
      return dataLocalISO(new Date((a > 1e11 ? a : a * 1000)), tz) === dataLocalISO(new Date(n * 1000), tz);
    }
    case 'numero':
    case 'dinheiro':
      return Number(atual.value) === Number(novo.value);
    default:
      return String(atual.value ?? '').trim() === String(novo.value ?? '').trim();
  }
}

export type Recusa = { ok: false; status: number; erro: string; precisaUnidade?: true; faltam?: CampoDoGuia[]; precisaConfirmar?: true };

/**
 * Confere e monta o que gravar. Recusa: campo que não existe, cabeçalho, campo que não é da SDR, a unidade já
 * escolhida (trocar é no Kommo) e — na conta de duas unidades com a unidade vazia — qualquer coisa antes da unidade.
 * O que já está igual no cartão não vai no PATCH (`iguais`).
 */
export function planejarCampos(
  defs: ReadonlyArray<DefinicaoDeCampo>,
  lead: CartaoDoGuia,
  campos: ReadonlyArray<CampoPedido>,
  tz: string,
): { ok: true; gravar: Gravacao[]; iguais: string[] } | Recusa {
  const unidade = campoPorNome(defs, CAMPO_UNIDADE);
  const unidadeVazia = !!unidade && vazioNoCartao(lead, unidade.id);
  if (unidadeVazia && !campos.some((c) => c.id === unidade!.id)) {
    return { ok: false, status: 409, erro: 'escolha primeiro a unidade de atendimento do paciente', precisaUnidade: true };
  }
  const gravar: Gravacao[] = [];
  const iguais: string[] = [];
  for (const c of campos) {
    const d = defs.find((x) => x.id === c.id);
    if (!d) return { ok: false, status: 422, erro: 'esse campo não existe no Kommo desta conta' };
    if (ehCabecalho(d.name)) return { ok: false, status: 403, erro: `${d.name.trim()} é só um título do cartão: não guarda valor` };
    if (!campoDaSdr(d)) {
      const quem = quemPreenche(d);
      return {
        ok: false,
        status: 403,
        erro: `${d.name.trim()} não é preenchido pela SDR${quem === 'franquia' ? ': quem preenche é a franquia' : quem === 'robo' ? ': quem preenche é o sistema' : ''}`,
      };
    }
    if (unidade && d.id === unidade.id && !unidadeVazia) {
      return { ok: false, status: 409, erro: 'a unidade de atendimento já está escolhida: para trocar, mude no Kommo' };
    }
    const v = valorParaOKommo(d, c.valor, tz);
    if (!v.ok) return { ok: false, status: 400, erro: v.erro };
    if (mesmoValor(d, lead, v.values, tz)) {
      iguais.push(d.name.trim());
      continue;
    }
    gravar.push({ field_id: d.id, values: v.values, nome: d.name.trim(), texto: v.texto });
  }
  return { ok: true, gravar, iguais };
}

/** O cartão com os valores que vão ser gravados (para conferir os obrigatórios antes de mover). */
export function cartaoComGravacoes(lead: CartaoDoGuia, gravar: ReadonlyArray<Gravacao>): CartaoDoGuia {
  const outros = (lead.custom_fields_values ?? []).filter((c) => !gravar.some((g) => g.field_id === c.field_id));
  return { ...lead, custom_fields_values: [...outros, ...gravar.map((g) => ({ field_id: g.field_id, values: g.values as ValorDoCampo['values'] }))] };
}

// ── as notas: quem fez ──

const quem = (por: string | null) => por || POR_PADRAO;
const listaDeCampos = (gravar: ReadonlyArray<Gravacao>) => gravar.map((g) => `${g.nome} = ${g.texto}`).join('; ');

/** "✎ Preenchido pela Ponte · por Ana: ⊘ Motivo da espera = Viajando; ◷ Retomar em = 20/10/2026" */
export function notaDosCampos(gravar: ReadonlyArray<Gravacao>, por: string | null): string {
  return `✎ Preenchido pela Ponte · por ${quem(por)}: ${listaDeCampos(gravar)}`;
}

/** "➜ Etapa mudada pela Ponte: EM QUALIFICAÇÃO → EM ESPERA · por Ana" (+ o que foi preenchido junto). */
export function notaDoMovimento(de: string, para: string, gravar: ReadonlyArray<Gravacao>, por: string | null): string {
  const base = `➜ Etapa mudada pela Ponte: ${de} → ${para} · por ${quem(por)}`;
  return gravar.length ? `${base}\nPreenchido junto: ${listaDeCampos(gravar)}` : base;
}

// ── o teto de movimentos por hora ──

/**
 * No máximo quantos cartões a Ponte move por hora numa CONTA (janela corrida). Mover dispara os robôs da etapa
 * (mensagem para o paciente): se a chave da unidade vazar, isto segura o estrago. `PONTE_MOVER_POR_HORA` muda.
 */
export const TETO_DE_MOVIMENTOS_POR_HORA = Math.max(1, Math.floor(numeroDoAmbiente(process.env.PONTE_MOVER_POR_HORA, 60)));

const HORA_MS = 60 * 60_000;
const movimentos = new Map<string, number[]>();

/** Confere o teto e RESERVA a vaga no mesmo passo (sem await no meio). `null` = não cabe. */
export function reservarMovimento(conta: string, teto = TETO_DE_MOVIMENTOS_POR_HORA, agoraMs = Date.now()): { devolver(): void } | null {
  const recentes = (movimentos.get(conta) ?? []).filter((t) => agoraMs - t < HORA_MS);
  if (recentes.length >= teto) {
    movimentos.set(conta, recentes);
    return null;
  }
  if (movimentos.size > 2_000) movimentos.clear();
  const marca = agoraMs;
  movimentos.set(conta, [...recentes, marca]);
  let devolvida = false;
  return {
    devolver() {
      if (devolvida) return;
      devolvida = true;
      const l = movimentos.get(conta) ?? [];
      const i = l.indexOf(marca);
      if (i >= 0) l.splice(i, 1);
    },
  };
}

// ── com o Kommo ──

/** O pedaço do `KommoClient` que o guia usa (o teste entra com um falso). */
export interface KommoDoGuia {
  getLead(leadId: number): Promise<CartaoDoGuia>;
  gravarCamposDoLead(leadId: number, campos: Array<{ field_id: number; values: Array<Record<string, unknown>> | null }>): Promise<void>;
  moverCartao(
    leadId: number,
    p: { statusId: number; pipelineId: number; campos?: Array<{ field_id: number; values: Array<Record<string, unknown>> | null }>; lossReasonId?: number | null },
  ): Promise<void>;
  addLeadNote(leadId: number, texto: string): Promise<unknown>;
  listLossReasons(): Promise<Array<{ id: number; name: string }>>;
}

/** O que o guia precisa da conta (o controller lê com cache). */
export interface ContaDoGuia {
  /** A chave da conta (subdomínio): o teto de movimentos é por conta. */
  conta: string;
  defs: ReadonlyArray<DefinicaoDeCampo>;
  funis: ReadonlyArray<FunilDoGuia>;
  tz: string;
  mensagens?: ReadonlyMap<string, readonly string[]>;
  /** Os motivos de perda do Kommo (cabeçalho do PERDIDO), lidos só quando vai para PERDIDO. */
  motivosDePerda?: () => Promise<Array<{ id: number; name: string }>>;
  teto?: number;
  /** O relógio (o teste fixa). */
  agora?: Date;
}

const naoAchou = (err: unknown) => err instanceof KommoApiError && (err.status === 404 || err.status === 204);

async function lerCartao(kommo: Pick<KommoDoGuia, 'getLead'>, leadId: number): Promise<CartaoDoGuia | null> {
  try {
    const lead = await kommo.getLead(leadId);
    return lead && typeof lead === 'object' && lead.id ? lead : null;
  } catch (err) {
    if (naoAchou(err)) return null;
    throw err;
  }
}

export type ResultadoDoGuia = { ok: true; guia: GuiaDoCartao } | Recusa;

/** O guia do cartão, lido agora do Kommo. */
export async function guiaDoCartao(ctx: ContaDoGuia, kommo: Pick<KommoDoGuia, 'getLead'>, leadId: number): Promise<ResultadoDoGuia> {
  const lead = await lerCartao(kommo, leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  return { ok: true, guia: montarGuia({ lead, defs: ctx.defs, funis: ctx.funis, tz: ctx.tz, mensagens: ctx.mensagens, agora: ctx.agora }) };
}

/** Confere no cartão RELIDO que cada campo gravado ficou com o valor pedido. Devolve os que não ficaram. */
function naoFicaram(defs: ReadonlyArray<DefinicaoDeCampo>, relido: CartaoDoGuia, gravar: ReadonlyArray<Gravacao>, tz: string): string[] {
  return gravar.filter((g) => {
    const d = defs.find((x) => x.id === g.field_id);
    return !d || !mesmoValor(d, relido, g.values, tz);
  }).map((g) => g.nome);
}

export type ResultadoDosCampos =
  | { ok: true; leadId: number; gravados: Array<{ nome: string; texto: string }>; iguais: string[]; nota: boolean | null; guia: GuiaDoCartao }
  | Recusa;

/** `POST …/ponte/campos`: grava só o que mudou (um PATCH), RELÊ o cartão e devolve o guia novo. Deixa nota de quem. */
export async function gravarCamposPelaPonte(ctx: ContaDoGuia, kommo: KommoDoGuia, pedido: PedidoDeCampos): Promise<ResultadoDosCampos> {
  const lead = await lerCartao(kommo, pedido.leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  const plano = planejarCampos(ctx.defs, lead, pedido.campos, ctx.tz);
  if (!plano.ok) return plano;
  const guia = (l: CartaoDoGuia) => montarGuia({ lead: l, defs: ctx.defs, funis: ctx.funis, tz: ctx.tz, mensagens: ctx.mensagens, agora: ctx.agora });
  if (!plano.gravar.length) {
    return { ok: true, leadId: lead.id, gravados: [], iguais: plano.iguais, nota: null, guia: guia(lead) };
  }
  await kommo.gravarCamposDoLead(lead.id, plano.gravar.map((g) => ({ field_id: g.field_id, values: g.values })));
  const relido = await lerCartao(kommo, lead.id).catch(() => null);
  if (relido) {
    const faltou = naoFicaram(ctx.defs, relido, plano.gravar, ctx.tz);
    if (faltou.length) return { ok: false, status: 502, erro: `o Kommo aceitou, mas ${faltou.join(', ')} não aparece no cartão: confira no Kommo` };
  }
  const nota = await kommo.addLeadNote(lead.id, notaDosCampos(plano.gravar, pedido.por)).then(
    () => true,
    () => false,
  );
  return {
    ok: true,
    leadId: lead.id,
    gravados: plano.gravar.map((g) => ({ nome: g.nome, texto: g.texto })),
    iguais: plano.iguais,
    nota,
    // sem a releitura (Kommo lento), o guia sai do que foi pedido — o painel relê na próxima vez
    guia: guia(relido ?? cartaoComGravacoes(lead, plano.gravar)),
  };
}

/** O motivo de perda do Kommo com o mesmo nome do motivo escolhido no campo ⊘ (ou null). */
export function motivoDePerdaCasado(escolhido: string | null, motivos: ReadonlyArray<{ id: number; name: string }>): { id: number; name: string } | null {
  if (!escolhido) return null;
  return motivos.find((m) => mesmoNome(m.name, escolhido)) ?? null;
}

export type ResultadoDoMovimento =
  | {
      ok: true;
      leadId: number;
      de: string;
      para: string;
      gravados: Array<{ nome: string; texto: string }>;
      motivoDePerda: string | null;
      nota: boolean;
      guia: GuiaDoCartao;
    }
  | Recusa;

/**
 * `POST …/ponte/mover`: muda a etapa (e grava junto o que faltava, num PATCH só). Recusa: sem confirmação; cartão
 * fora do COMERCIAL; etapa que mudou desde que o painel abriu o guia; destino que não é saída desta etapa (GANHO e
 * TRATAMENTO nunca); unidade vazia na conta de duas unidades; obrigatório do destino faltando (cumulativo) ou o que
 * a saída pede; teto de movimentos por hora. Depois RELÊ o cartão e confere que andou.
 */
export async function moverPelaPonte(ctx: ContaDoGuia, kommo: KommoDoGuia, pedido: PedidoDeMover): Promise<ResultadoDoMovimento> {
  if (!pedido.confirmado) {
    return { ok: false, status: 409, erro: 'mover dispara os robôs da etapa: confirme antes', precisaConfirmar: true };
  }
  const lead = await lerCartao(kommo, pedido.leadId);
  if (!lead) return { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' };
  const comercial = funilComercialDoGuia(ctx.funis);
  if (!comercial || lead.pipeline_id !== comercial.id) {
    return { ok: false, status: 409, erro: 'este cartão não está no funil COMERCIAL: a Ponte só move cartão no COMERCIAL' };
  }
  const atual = comercial.statuses.find((s) => s.id === lead.status_id);
  if (!atual) return { ok: false, status: 409, erro: 'não achei a etapa deste cartão no Kommo' };
  if (lead.status_id !== pedido.de) {
    return { ok: false, status: 409, erro: `o cartão mudou de etapa (agora está em ${atual.name}): abra o guia de novo` };
  }
  const destino = comercial.statuses.find((s) => s.id === pedido.para);
  const saida = destino ? saidasDaEtapa(atual).find((s) => etapaPorNome(comercial, s.para)?.id === destino.id) ?? null : null;
  if (!destino || !saida || destino.id === atual.id || !ehEtapaDaSdr(destino)) {
    return { ok: false, status: 403, erro: `a Ponte não move de ${atual.name} para ${destino?.name ?? 'essa etapa'}` };
  }

  const plano = pedido.campos.length ? planejarCampos(ctx.defs, lead, pedido.campos, ctx.tz) : { ok: true as const, gravar: [] as Gravacao[], iguais: [] as string[] };
  if (!plano.ok) return plano;
  const unidade = campoPorNome(ctx.defs, CAMPO_UNIDADE);
  const depois = cartaoComGravacoes(lead, plano.gravar);
  if (unidade && vazioNoCartao(depois, unidade.id)) {
    return { ok: false, status: 409, erro: 'escolha primeiro a unidade de atendimento do paciente', precisaUnidade: true };
  }
  const passou = dataNoPassado(ctx.defs, saida, depois, ctx.tz, ctx.agora ?? new Date());
  if (passou) return { ok: false, status: 422, erro: dicaDaDataNoPassado(passou, depois, ctx.tz).replace(/\.$/, ''), faltam: [{ ...campoDoGuia(passou, depois, ctx.tz, true, dicaDaDataNoPassado(passou, depois, ctx.tz)), editavel: false }] };
  const faltam = faltamParaEntrar(ctx.defs, comercial, destino, saida, depois);
  if (faltam.length) {
    return {
      ok: false,
      status: 422,
      erro: `para ir para ${destino.name}, falta preencher: ${faltam.map((d) => d.name.trim()).join(', ')}`,
      faltam: faltam.map((d) => campoDoGuia(d, depois, ctx.tz, true)),
    };
  }

  const vaga = reservarMovimento(ctx.conta, ctx.teto ?? TETO_DE_MOVIMENTOS_POR_HORA);
  if (!vaga) {
    return { ok: false, status: 429, erro: `a Ponte já moveu ${ctx.teto ?? TETO_DE_MOVIMENTOS_POR_HORA} cartões nesta conta na última hora: mova este pelo Kommo ou espere` };
  }
  let andou = false;
  try {
    // PERDIDO: o motivo de perda do cabeçalho do Kommo com o MESMO nome do ⊘ escolhido (os robôs de mensagem e a
    // Sofia leem esse; motivos como "Sem interesse" calam o acompanhamento). Sem nome igual, vai sem.
    let motivo: { id: number; name: string } | null = null;
    if (destino.id === PERDIDO && ctx.motivosDePerda) {
      const escolhido = CAMPOS_DO_MOTIVO.map((n) => campoPorNome(ctx.defs, n))
        .filter((d): d is DefinicaoDeCampo => !!d)
        .map((d) => textoDoValor(d, valoresDe(depois, d.id), ctx.tz))
        .find((t): t is string => !!t) ?? null;
      motivo = motivoDePerdaCasado(escolhido, await ctx.motivosDePerda().catch(() => []));
    }
    await kommo.moverCartao(lead.id, {
      statusId: destino.id,
      pipelineId: comercial.id,
      campos: plano.gravar.map((g) => ({ field_id: g.field_id, values: g.values })),
      lossReasonId: motivo?.id ?? null,
    });
    const relido = await lerCartao(kommo, lead.id).catch(() => null);
    if (relido && relido.status_id !== destino.id) {
      return { ok: false, status: 502, erro: 'o Kommo aceitou, mas o cartão não mudou de etapa: confira no Kommo' };
    }
    andou = true;
    if (relido) {
      const faltou = naoFicaram(ctx.defs, relido, plano.gravar, ctx.tz);
      if (faltou.length) return { ok: false, status: 502, erro: `o cartão mudou de etapa, mas ${faltou.join(', ')} não aparece no cartão: confira no Kommo` };
    }
    const nota = await kommo.addLeadNote(lead.id, notaDoMovimento(atual.name, destino.name, plano.gravar, pedido.por)).then(
      () => true,
      () => false,
    );
    const final = relido ?? { ...depois, status_id: destino.id };
    return {
      ok: true,
      leadId: lead.id,
      de: atual.name,
      para: destino.name,
      gravados: plano.gravar.map((g) => ({ nome: g.nome, texto: g.texto })),
      motivoDePerda: motivo?.name ?? null,
      nota,
      guia: montarGuia({ lead: final, defs: ctx.defs, funis: ctx.funis, tz: ctx.tz, mensagens: ctx.mensagens, agora: ctx.agora }),
    };
  } finally {
    if (!andou) vaga.devolver();
  }
}

/** Para o teste começar limpo. */
export function limparTetoDeMovimentos(): void {
  movimentos.clear();
}
