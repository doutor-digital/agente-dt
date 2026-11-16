/**
 * Captura silenciosa (16/11/2026, pedido da Petrópolis): "a IA preenche os campos de cada etapa — não está fazendo".
 *
 * Por que não fazia: de dia, em Petrópolis, quem atende é a SDR pelo celular e a Sofia só fala de 18h às 9h. O turno que sai
 * por `__out_of_hours__` (ou pausa, ou etapa calada, ou equipe falando) devolve `TURNO_PULADO` ANTES de tudo — e a captura de
 * campos (`registrar_campo`) só existe dentro do turno em que a Sofia fala. Em 4 dias foram 357 turnos assim, com a conversa
 * inteira (paciente + SDR) passando sem ninguém anotar a queixa, a região da dor, a qualificação.
 *
 * O que ela faz: quando o turno é PULADO, espera a conversa esfriar (~10 min sem fala nova), LÊ a conversa inteira no Kommo
 * (paciente + equipe + Sofia, a mesma leitura da cutucada) e pede a uma IA barata SÓ os campos que a etapa atual do cartão mostra
 * e que estão VAZIOS. As definições vêm das regras de captura da Sofia (`lead_field_rules`: nome, tipo, opções, "quando
 * preencher") e a lista de campos da etapa vem do próprio cartão do Kommo (`hidden_statuses`, o molde de cabeçalho por etapa).
 *
 * O que ela NUNCA faz: sobrescrever campo com valor (da SDR ou da IA — relê o cartão logo antes de gravar), mandar mensagem,
 * mover etapa, mexer em número interno, currículo, funil TRATAMENTO ou cartão fechado. Só grava com a chave `ligado`; em
 * `seco` a leitura RODA (centavos) e a decisão vai para a tela «Só no papel» ("gravaria campo X = Y").
 *
 * Só a lista CAMPOS_CAPTURAVEIS é tocada. Campos que OUTRO robô escreve (⬢ Tipo de lead, motivo do não agendamento, situação da
 * consulta, retomar em…) ficam de fora de propósito: dois escritores no mesmo campo viram regravação eterna.
 */
import type { Unit, LeadFieldRule } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { ehNumeroInterno, lerNumerosInternos } from './numeros-internos.js';
import { dataLocalISO } from './feriados.js';
import { fusoDaUnidade } from './fuso.js';
import { normalizar } from './franquia-sync.js';
import { ETIQUETA_CURRICULO } from './nao-paciente.js';
import { carregarFunis, type Funis } from './franquia-sync-worker.js';
import { GANHO, PERDIDO, CAMPOS_DO_ANUNCIO, escondidoEm, ehCabecalho, vazioNoCartao } from './ponte-guia.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';
import { grupoDaUnidade, pularCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { cartaoComEtiquetaDeRobo, reclassificarFalas, type Fala } from './cutucada-apos-equipe.js';
import { temEtiqueta } from './rotina-nucleo.js';
import { chamarAnthropic, type Chamar } from './cadastro-triagem-ia.js';
import { coergirValor } from '../agent/captura-unificada.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { historicoOficial } from '../services/kommo-talks-normalizar.js';
import { enviosDaSofia } from '../services/kommo-talks.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { calculateCost } from '../services/openai.service.js';

export const ID_CAPTURA_SILENCIOSA = 'captura-silenciosa';

/** Estado da chave na unidade (a tela manda; sem linha, vale `CAPTURA_SILENCIOSA_SLUGS`). */
export const estadoDaCapturaSilenciosa = (slug: string, raw: string | undefined = process.env.CAPTURA_SILENCIOSA_SLUGS): Estado => estadoDaAutomacao(slug, ID_CAPTURA_SILENCIOSA, raw);

// ─── os números ───────────────────────────────────────────────────────────────────────────────────

const inteiroDoAmbiente = (v: string | undefined, padrao: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

/** A conversa "esfriou": tanto tempo sem fala nova (de ninguém) antes de ler. Cada turno pulado novo recomeça a contagem. */
export const DEBOUNCE_MS = inteiroDoAmbiente(process.env.CAPTURA_SILENCIOSA_DEBOUNCE_MIN, 10) * 60_000;
/** Se na hora de ler ainda há fala fresca (a SDR respondeu agora), espera mais — no máximo isto de vezes. */
export const MAX_ADIAMENTOS = 3;
/** Quantas vezes UM cartão pode gastar leitura de conversa + IA por dia. */
export const MAX_LEITURAS_POR_CARTAO_DIA = inteiroDoAmbiente(process.env.CAPTURA_SILENCIOSA_MAX_CARTAO_DIA, 3);
/** Quantas leituras a unidade inteira gasta por dia (o teto de custo: ~US$ 0,001 cada). */
export const MAX_LEITURAS_POR_UNIDADE_DIA = inteiroDoAmbiente(process.env.CAPTURA_SILENCIOSA_MAX_UNIDADE_DIA, 150);
/** Cartões esperando a conversa esfriar, no processo todo. Cheio = não agenda (o próximo turno pulado tenta de novo). */
export const MAX_AGENDADOS = 3000;
const MAX_FALAS = 60;
const MAX_AUDIOS = 3;
/** Quanto o paciente tem de ter escrito (letras e números, no total) para a IA valer a chamada: «oi, bom dia» tem ~9. */
const MIN_CHARS_DO_PACIENTE = 12;
/** Uma leitura (Kommo + transcrição + IA) não prende a fila de ninguém por mais que isto. */
export const PRAZO_DA_LEITURA_MS = 120_000;
const MAX_CHARS_POR_FALA = 500;
const MODELO = process.env.CAPTURA_SILENCIOSA_MODELO?.trim() || 'claude-haiku-5-5';
const MAX_TOKENS = 700;
const TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 10 * 60_000;

// ─── quais campos ─────────────────────────────────────────────────────────────────────────────────

/**
 * As regras de captura da Sofia (`tool_name`) que a leitura silenciosa pode preencher: o que a conversa conta. Lista FECHADA — regra
 * que não está aqui (nem as que a Sofia criar depois) não é tocada. Ficam de fora, de propósito:
 *  - ⬢ Tipo de lead (o robô da chegada / `campos-sdr`), ⊘ Motivo do não agendamento (`perda-ia`), ✓ Situação da consulta e Feito por
 *    (a franquia), ◷ Retomar em e ⊘ Motivo da espera (têm retomada automática atrás), Forma de pagamento (comprovante), opt-out;
 *  - os de controle da própria IA (intenção, sentimento, status da conversa, fallback, motivo do handoff, resultado da qualificação);
 *  - o nome do paciente (`updatesLeadTitle`): é do renomear-lead.
 */
export const CAMPOS_CAPTURAVEIS: ReadonlySet<string> = new Set([
  'registra_queixa',
  'registra_regiao_dor',
  'registra_qualificacao',
  'registra_observacoes',
  'registra_origem',
  'registra_cidade',
  'registra_estado',
  'registra_bairro',
  'registra_sexo',
  'registra_plano_saude',
  'registra_profissao',
  'registra_preferencia_horario',
]);

/** Julgamento ou resumo da conversa, não um fato que o paciente disse: não exige uma frase literal dele como prova. */
const SEM_FRASE_DE_PROVA: ReadonlySet<string> = new Set(['registra_qualificacao', 'registra_observacoes']);
/**
 * Fato curto que o paciente tem de ter ESCRITO (o valor aparece, ao pé da letra, numa fala dele): cidade, estado, bairro, profissão, plano.
 * A IA pode escolher uma frase qualquer dele como "prova" de um valor que ela inventou; nestes campos o valor em si é conferido.
 */
const VALOR_LITERAL_NA_FALA: ReadonlySet<string> = new Set(['registra_cidade', 'registra_estado', 'registra_bairro', 'registra_profissao', 'registra_plano_saude']);
/** Texto livre (queixa e afins): a frase citada precisa dividir ao menos uma palavra (as 5 primeiras letras: lombar/lombalgia) com o valor — "bom dia" não prova "dor lombar crônica". */
const MIN_LETRAS_DA_PALAVRA_EM_COMUM = 5;
/** A Sofia pede 2 respostas do paciente antes de qualificar; a leitura silenciosa não qualifica com menos. */
const MIN_FALAS_PARA_QUALIFICAR = 2;
const NOME_ORIGEM = '⚑ Origem';

/** Os tipos que `setLeadCustomFieldValue` sabe gravar (streetaddress, date_time, url… lançariam "tipo não suportado" depois de a IA já ter sido paga). */
const TIPOS_QUE_O_GRAVADOR_ACEITA: ReadonlySet<string> = new Set(['text', 'textarea', 'numeric', 'monetary', 'date', 'birthday', 'select', 'radiobutton', 'multiselect']);

export interface CampoCandidato {
  regra: LeadFieldRule;
  def: DefinicaoDeCampo;
}

export interface EntradaDosCampos {
  regras: readonly LeadFieldRule[];
  defs: readonly DefinicaoDeCampo[];
  lead: Pick<KommoLead, 'id' | 'pipeline_id' | 'status_id' | 'custom_fields_values'>;
}

/**
 * Os campos que a etapa ATUAL do cartão pede, que a Sofia sabe captar e que estão VAZIOS. Puro.
 * Pede = a regra existe e está ligada na unidade, o campo existe na conta, aparece nesta etapa (não está em `hidden_statuses`),
 * não é "Apenas API" e é de um tipo que sabemos gravar. Vazio = o cartão não tem valor nenhum (nunca sobrescreve).
 */
export function camposDaEtapaVazios(e: EntradaDosCampos): CampoCandidato[] {
  const porId = new Map(e.defs.map((d) => [d.id, d] as const));
  // Origem: o rastreio de anúncio grava ⚑ Origem (e campanha, anúncio…). Cartão com rastro de anúncio já tem dono para a origem —
  // uma "indicação" dita no meio da conversa não pode competir com ele.
  const defsDoAnuncio = e.defs.filter((d) => d.name.trim() !== NOME_ORIGEM && CAMPOS_DO_ANUNCIO.some((n) => normalizar(n) === normalizar(d.name)));
  const temRastroDeAnuncio = defsDoAnuncio.some((d) => !vazioNoCartao(e.lead, d.id));
  const out: CampoCandidato[] = [];
  for (const regra of e.regras) {
    if (!regra.enabled || !CAMPOS_CAPTURAVEIS.has(regra.toolName) || regra.updatesLeadTitle) continue;
    const def = porId.get(regra.kommoFieldId);
    if (!def || ehCabecalho(def.name)) continue;
    if ((def as { is_api_only?: boolean }).is_api_only) continue;
    if (!TIPOS_QUE_O_GRAVADOR_ACEITA.has(def.type)) continue;
    if (escondidoEm(def, e.lead.pipeline_id, e.lead.status_id)) continue;
    if (!vazioNoCartao(e.lead, def.id)) continue;
    if (regra.toolName === 'registra_origem' && temRastroDeAnuncio) continue;
    out.push({ regra, def });
  }
  return out.sort((a, b) => ((a.def as { sort?: number }).sort ?? 0) - ((b.def as { sort?: number }).sort ?? 0) || a.def.id - b.def.id);
}

// ─── quem fica de fora ────────────────────────────────────────────────────────────────────────────

export interface EntradaDasExclusoes {
  lead: Pick<KommoLead, 'pipeline_id' | 'status_id' | 'closed_at' | '_embedded' | 'custom_fields_values' | 'loss_reason_id' | 'id' | 'name'>;
  funis: Pick<Funis, 'comercialId' | 'tratamentoId'>;
}

/**
 * Por que este cartão NUNCA é lido/escrito (null = pode). Currículo, funil TRATAMENTO (paciente em tratamento), qualquer funil que
 * não seja o COMERCIAL e cartão fechado (GANHO/PERDIDO; ALTA é o 142 do TRATAMENTO e cai no funil). Puro.
 */
export function porQueNaoCapturar(e: EntradaDasExclusoes): string | null {
  const { lead, funis } = e;
  if (funis.tratamentoId !== null && lead.pipeline_id === funis.tratamentoId) return 'funil TRATAMENTO (paciente em tratamento)';
  if (lead.pipeline_id !== funis.comercialId) return 'fora do funil COMERCIAL';
  if (lead.status_id === GANHO || lead.status_id === PERDIDO || lead.closed_at) return 'cartão fechado (GANHO/PERDIDO)';
  if (temEtiqueta(lead, ETIQUETA_CURRICULO)) return 'currículo (não é paciente)';
  return null;
}

// ─── a conversa e o pedido à IA ───────────────────────────────────────────────────────────────────

const ROTULO: Record<Fala['autor'], string> = { paciente: 'PACIENTE', equipe: 'EQUIPE DA CLÍNICA', sofia: 'SOFIA (IA da clínica)', robo: 'MENSAGEM AUTOMÁTICA' };

/** A conversa como a IA lê: uma linha por fala, com quem falou. Áudio do paciente já transcrito vem no texto. */
export function conversaInteira(falas: readonly Fala[], max = MAX_FALAS): string {
  return falas
    .slice(-max)
    .map((f) => {
      const marca = f.anexo ? (f.anexo === 'voice' ? '[áudio]' : f.anexo === 'picture' ? '[imagem]' : `[${f.anexo}]`) : '';
      const corpo = [f.texto.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_POR_FALA), marca].filter(Boolean).join(' ') || '[mensagem vazia]';
      return `${ROTULO[f.autor]}: ${corpo}`;
    })
    .join('\n');
}

export const INSTRUCAO = [
  'Você lê a conversa de WhatsApp entre um paciente (ou interessado) e uma clínica, e preenche campos do cartão dele no CRM.',
  'Você NÃO conversa, NÃO responde ao paciente e NÃO decide nada além dos campos pedidos. Responda SOMENTE com JSON.',
  'Regras:',
  '- Preencha um campo SÓ se a conversa disser com clareza. Na dúvida, NÃO inclua o campo. Campo vazio é melhor que campo errado.',
  '- A prova é o que o PACIENTE disse. O que a EQUIPE ou a SOFIA escreveram sobre ele só vale se o paciente confirmou. Cuidado com terceiros: se quem escreve é a esposa/filho, o campo é do PACIENTE (quem vai consultar).',
  '- Campo de lista: devolva EXATAMENTE uma das opções mostradas (lista múltipla: opções separadas por ";"). Texto livre: curto, em português, sem inventar.',
  '- "trecho" é a frase do PACIENTE, copiada LITERALMENTE da conversa (até 140 caracteres), que prova o valor. Só ★ Qualificação e ✎ Observações podem ir sem trecho.',
  '- ✎ Queixa só vale se o PACIENTE descreveu o que sente (onde dói, há quanto tempo, o que limita). Pergunta sobre preço, horário, exame ou tratamento NÃO é queixa: nesse caso não preencha. Use as palavras dele; não acrescente sintoma, tempo ou causa que ele não citou.',
  '- ✎ Observações: no máximo 2 frases curtas, com o que quem for atender precisa saber antes de abrir a conversa (quem é o paciente, o que pediu, se mandou exame). Não repita a queixa inteira.',
  '- Nunca invente telefone, nome, data nem valor. Não repita no JSON campos que não foram pedidos.',
  'Formato: {"campos":[{"campo":"<nome exato do campo>","valor":"<valor>","trecho":"<frase do paciente>"}]}. Nada a preencher: {"campos":[]}.',
].join('\n');

const MAX_INSTRUCAO_DO_CAMPO = 320;

/** Opção que não é resposta ("Não informada", "Sem origem"): gravar isso só enche o campo com um vazio disfarçado. */
const OPCAO_SEM_INFORMACAO = /^(n[aã]o informad|sem origem)/i;
/** A ⚑ Origem tem opções que são do rastreio de anúncio (Meta-Instagram, Org-WhatsApp, WhatsApp anúncio…): a conversa não prova clique. */
const OPCAO_DO_RASTREIO = /^(meta-|org-|whatsapp an[uú]ncio)/i;

/** As opções que a leitura silenciosa pode escolher neste campo (a lista da conta menos as que ela nunca deve escolher). */
export function opcoesPermitidas(c: CampoCandidato): Array<{ id: number; value: string }> {
  return (c.def.enums ?? []).filter((e) => e.value && !OPCAO_SEM_INFORMACAO.test(e.value.trim()) && !(c.regra.toolName === 'registra_origem' && OPCAO_DO_RASTREIO.test(e.value.trim()))) as Array<{ id: number; value: string }>;
}

function linhaDoCampo(c: CampoCandidato): string {
  const enums = opcoesPermitidas(c).map((e) => e.value);
  const tipo = c.def.type;
  const formato = enums.length && (tipo === 'select' || tipo === 'radiobutton') ? ` Opções: ${enums.join(' | ')}.` : enums.length && tipo === 'multiselect' ? ` Uma ou mais, separadas por ";": ${enums.join(' | ')}.` : '';
  const quando = c.regra.instruction.replace(/\s+/g, ' ').trim().slice(0, MAX_INSTRUCAO_DO_CAMPO);
  return `• «${c.def.name.trim()}» — ${quando}${formato}`;
}

export function montarPedido(candidatos: readonly CampoCandidato[], falas: readonly Fala[]): string {
  return [
    'Campos que o cartão pede agora (todos estão vazios):',
    ...candidatos.map(linhaDoCampo),
    '',
    'Conversa (da mais antiga à mais nova):',
    conversaInteira(falas),
  ].join('\n');
}

const RespostaZ = z.object({
  campos: z
    .array(
      z.object({
        campo: z.string(),
        valor: z.union([z.string(), z.array(z.string()), z.number()]),
        trecho: z.string().optional().default(''),
      }),
    )
    .default([]),
});
export type SugestaoDaIa = z.infer<typeof RespostaZ>['campos'][number];

/** Lê o JSON da resposta (a IA às vezes embrulha em ```). `null` = não deu para ler: nada é gravado. */
export function lerResposta(texto: string): SugestaoDaIa[] | null {
  const ini = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    const r = RespostaZ.safeParse(JSON.parse(texto.slice(ini, fim + 1)));
    return r.success ? r.data.campos : null;
  } catch {
    return null;
  }
}

const palavrasDe = (t: string) => normalizar(t).split(' ').filter((w) => w.length >= MIN_LETRAS_DA_PALAVRA_EM_COMUM).map((w) => w.slice(0, MIN_LETRAS_DA_PALAVRA_EM_COMUM));
function palavraEmComum(valor: string, trecho: string): boolean {
  const doTrecho = new Set(palavrasDe(trecho));
  return palavrasDe(valor).some((w) => doTrecho.has(w));
}

export interface Aceita {
  candidato: CampoCandidato;
  valor: string | number | string[];
  /** como o valor aparece na tela e na nota */
  texto: string;
  trecho: string;
}
export interface Recusada {
  campo: string;
  motivo: string;
}

const MIN_CHARS_DO_TRECHO = 6;

/**
 * O que da resposta da IA vale. Puro. Cada sugestão passa por: é um campo PEDIDO (e só uma vez); o valor existe na lista do campo
 * (`coergirValor`, a mesma da Sofia — opção inventada não grava); e a FRASE do paciente que a IA cita está mesmo numa fala dele
 * (palpite sem prova não vira dado do cartão). Qualificação e Observações dispensam a frase; Qualificação pede 2 falas do paciente.
 */
export function validarSugestoes(sugestoes: readonly SugestaoDaIa[], candidatos: readonly CampoCandidato[], falas: readonly Fala[]): { aceitas: Aceita[]; recusadas: Recusada[] } {
  const aceitas: Aceita[] = [];
  const recusadas: Recusada[] = [];
  const doPaciente = falas.filter((f) => f.autor === 'paciente');
  const textoDoPaciente = normalizar(doPaciente.map((f) => f.texto).join(' \n '));
  const vistos = new Set<number>();
  for (const s of sugestoes) {
    const alvo = normalizar(s.campo);
    const c = candidatos.find((x) => normalizar(x.def.name) === alvo);
    if (!c) {
      recusadas.push({ campo: s.campo, motivo: 'a IA citou um campo que não foi pedido' });
      continue;
    }
    if (vistos.has(c.def.id)) continue;
    vistos.add(c.def.id);
    const nome = c.def.name.trim();
    // lista sem nenhuma opção permitida: `coergirValor` aceitaria texto livre, e campo de lista não aceita
    if (['select', 'radiobutton', 'multiselect'].includes(c.def.type) && !opcoesPermitidas(c).length) {
      recusadas.push({ campo: nome, motivo: 'o campo não tem opção que a leitura possa escolher' });
      continue;
    }
    const co = coergirValor({ kommoFieldType: c.def.type, kommoFieldEnums: opcoesPermitidas(c) as never, kommoFieldName: nome }, s.valor);
    if (!co.ok) {
      recusadas.push({ campo: nome, motivo: co.erro.slice(0, 160) });
      continue;
    }
    const trecho = s.trecho.replace(/[…]|\.{3}/g, ' ').replace(/\s+/g, ' ').trim();
    if (c.regra.toolName === 'registra_qualificacao' && doPaciente.length < MIN_FALAS_PARA_QUALIFICAR) {
      recusadas.push({ campo: nome, motivo: `só ${doPaciente.length} fala do paciente: cedo para qualificar` });
      continue;
    }
    if (!SEM_FRASE_DE_PROVA.has(c.regra.toolName)) {
      const t = normalizar(trecho);
      if (t.length < MIN_CHARS_DO_TRECHO || !textoDoPaciente.includes(t)) {
        recusadas.push({ campo: nome, motivo: 'a frase que a IA citou não está numa fala do paciente (sem prova, não grava)' });
        continue;
      }
    }
    const texto = Array.isArray(co.valor) ? co.valor.join('; ') : String(co.valor);
    if (VALOR_LITERAL_NA_FALA.has(c.regra.toolName) && !textoDoPaciente.includes(normalizar(texto))) {
      recusadas.push({ campo: nome, motivo: `«${texto.slice(0, 60)}» não aparece escrito numa fala do paciente` });
      continue;
    }
    if (!SEM_FRASE_DE_PROVA.has(c.regra.toolName) && (c.def.type === 'text' || c.def.type === 'textarea') && !palavraEmComum(texto, trecho)) {
      recusadas.push({ campo: nome, motivo: 'a frase que a IA citou não tem relação com o valor (nenhuma palavra em comum)' });
      continue;
    }
    aceitas.push({ candidato: c, valor: co.valor, texto, trecho: trecho.slice(0, 140) });
  }
  return { aceitas, recusadas };
}

// ─── tetos ────────────────────────────────────────────────────────────────────────────────────────

const leiturasDoDia = new Map<string, number>();
let diaDasLeituras = '';

function zerarSeVirouODia(dia: string): void {
  if (dia !== diaDasLeituras) {
    leiturasDoDia.clear();
    diaDasLeituras = dia;
  }
}

const chaveDoCartao = (unitId: string, leadId: number, dia: string) => `c:${unitId}:${leadId}:${dia}`;
const chaveDaUnidade = (unitId: string, dia: string) => `u:${unitId}:${dia}`;

/** Por que não dá para gastar mais uma leitura hoje (null = dá). */
export function porQueOTetoSegura(unitId: string, leadId: number, dia: string): string | null {
  zerarSeVirouODia(dia);
  if ((leiturasDoDia.get(chaveDoCartao(unitId, leadId, dia)) ?? 0) >= MAX_LEITURAS_POR_CARTAO_DIA) return `teto do cartão no dia (${MAX_LEITURAS_POR_CARTAO_DIA} leituras)`;
  if ((leiturasDoDia.get(chaveDaUnidade(unitId, dia)) ?? 0) >= MAX_LEITURAS_POR_UNIDADE_DIA) return `teto da unidade no dia (${MAX_LEITURAS_POR_UNIDADE_DIA} leituras)`;
  return null;
}

function gastarLeitura(unitId: string, leadId: number, dia: string): void {
  zerarSeVirouODia(dia);
  for (const k of [chaveDoCartao(unitId, leadId, dia), chaveDaUnidade(unitId, dia)]) leiturasDoDia.set(k, (leiturasDoDia.get(k) ?? 0) + 1);
}

/** Só para teste. */
export function _limparCapturaParaTeste(): void {
  leiturasDoDia.clear();
  diaDasLeituras = '';
  ultimaLeitura.clear();
  for (const t of agendados.values()) clearTimeout(t.timer);
  agendados.clear();
  filaSerial = Promise.resolve();
  cacheFunis.clear();
  cacheCampos.clear();
  transcricoes.clear();
}

/** unit:lead → "id da última mensagem|campos pedidos" da última leitura. Conversa e pedido iguais = a resposta seria a mesma: não paga de novo. */
const ultimaLeitura = new Map<string, string>();

// ─── a leitura de um cartão ───────────────────────────────────────────────────────────────────────

export type KommoDaCaptura = Pick<KommoClient, 'getLead' | 'getContactPhone' | 'setLeadCustomFieldValue' | 'addLeadNote'>;

/** O que o agendador guarda da unidade durante a espera: só a identidade (a linha inteira tem tokens e não precisa ficar na memória 10 min). */
export type UnidadeDoAgendamento = Pick<Unit, 'id' | 'slug'>;

export interface DepsDaCaptura {
  agora: () => Date;
  /** A unidade como está AGORA no banco (token e chave podem ter mudado nos minutos de espera). `null` = a unidade sumiu. */
  unidade: (ref: UnidadeDoAgendamento) => Promise<Unit | null>;
  estado: (slug: string) => Estado;
  kommo: (unit: Unit) => KommoDaCaptura;
  regras: (unit: Unit) => Promise<LeadFieldRule[]>;
  funis: (unit: Unit, kommo: KommoDaCaptura) => Promise<Pick<Funis, 'comercialId' | 'tratamentoId' | 'nomeDe'> | null>;
  campos: (unit: Unit, kommo: KommoDaCaptura) => Promise<DefinicaoDeCampo[]>;
  grupo: (unit: Unit) => Promise<GrupoDoCrm | null>;
  /** A conversa inteira, já separada em paciente / equipe / Sofia / robô. Não transcreve nada (isso custa): `audios` diz de onde. */
  falas: (unit: Unit, kommo: KommoDaCaptura, lead: KommoLead) => Promise<{ falas: Fala[]; ultimaId: string; audios: ReadonlyMap<string, string> }>;
  /** Troca o «[áudio]» das últimas falas do paciente pelo que ele disse (até 3, com cache por mensagem). Só roda depois de todos os portões baratos. */
  transcrever: (unit: Unit, falas: Fala[], audios: ReadonlyMap<string, string>) => Promise<void>;
  /** `null` = a IA não respondeu (sem chave, fora do ar): nada é gravado. */
  perguntar: (unit: Unit, user: string) => Promise<{ texto: string; custoUsd: number } | null>;
  simular: typeof registrarSimulacao;
}

export type ResultadoDaCaptura =
  | { tipo: 'desligada' }
  | { tipo: 'pulou'; motivo: string }
  | { tipo: 'adiada'; emMs: number }
  | {
      tipo: 'leu';
      seco: boolean;
      pedidos: string[];
      gravaria: Array<{ campo: string; valor: string; trecho: string }>;
      gravou: Array<{ campo: string; valor: string }>;
      recusadas: Recusada[];
      custoUsd: number;
    };

function contatoPrincipal(lead: Pick<KommoLead, '_embedded'>): number | null {
  const c = lead._embedded?.contacts ?? [];
  return (c.find((x) => x.is_main) ?? c[0])?.id ?? null;
}

/**
 * Uma leitura silenciosa de UM cartão. Nunca manda mensagem, nunca move etapa. Erro do Kommo ou da IA lança para quem chamou
 * (o agendador registra e segue); "não há o que fazer" é um resultado, não um erro.
 */
export async function lerCartaoEmSilencio(unit: Unit, leadId: number, deps: DepsDaCaptura, o: { esperarEsfriar?: boolean } = {}): Promise<ResultadoDaCaptura> {
  const estado = deps.estado(unit.slug);
  if (estado === 'desligado') return { tipo: 'desligada' };
  const seco = estado !== 'ligado';
  const agora = deps.agora();
  const dia = dataLocalISO(agora, fusoDaUnidade(unit));

  // 1) o barato: tetos, que não custam chamada nenhuma
  const teto = porQueOTetoSegura(unit.id, leadId, dia);
  if (teto) return { tipo: 'pulou', motivo: teto };

  // 2) o cartão, o funil e as exclusões
  const kommo = deps.kommo(unit);
  const lead = await kommo.getLead(leadId);
  const funis = await deps.funis(unit, kommo);
  if (!funis) return { tipo: 'pulou', motivo: 'não achei o funil COMERCIAL da conta' };
  const fora = porQueNaoCapturar({ lead, funis });
  if (fora) return { tipo: 'pulou', motivo: fora };
  const grupo = await deps.grupo(unit);
  if (pularCartao(grupo, unit.id, lead, {})) return { tipo: 'pulou', motivo: 'Kommo dividido: o cartão é de outra unidade (ou ainda sem unidade)' };
  const contato = contatoPrincipal(lead);
  const telefone = contato ? await kommo.getContactPhone(contato).catch(() => null) : null;
  if (telefone && ehNumeroInterno(telefone)) return { tipo: 'pulou', motivo: 'número interno da rede (NUMEROS_INTERNOS)' };
  // na dúvida, não lê: com a lista de internos preenchida e sem o telefone, não dá para afirmar que o número não é da rede
  if (!telefone && lerNumerosInternos().chaves.size > 0) return { tipo: 'pulou', motivo: 'não consegui o telefone do contato para conferir os números internos' };

  // 3) os campos que a etapa pede e estão vazios — sem nenhum, nem lê a conversa
  const [regras, defs] = await Promise.all([deps.regras(unit), deps.campos(unit, kommo)]);
  const candidatos = camposDaEtapaVazios({ regras, defs, lead });
  if (!candidatos.length) return { tipo: 'pulou', motivo: 'a etapa não pede nenhum campo vazio que a conversa possa preencher' };

  // 4) a conversa inteira (ainda sem transcrever áudio: o que for descartado abaixo não paga Whisper)
  const { falas, ultimaId, audios } = await deps.falas(unit, kommo, lead);
  const doPaciente = falas.filter((f) => f.autor === 'paciente');
  if (!doPaciente.length) return { tipo: 'pulou', motivo: 'o paciente não escreveu nada que se leia' };
  // «oi», «bom dia»: não há o que o paciente tenha contado, e a IA seria paga à toa (áudio ainda sem texto conta como algo contado)
  const contouAlgo = doPaciente.some((f) => f.anexo === 'voice') || normalizar(doPaciente.map((f) => f.texto).join(' ')).length >= MIN_CHARS_DO_PACIENTE;
  if (!contouAlgo) return { tipo: 'pulou', motivo: 'o paciente ainda não contou nada além de um cumprimento' };
  const ultimaEm = falas.reduce((m, f) => Math.max(m, f.em.getTime()), 0);
  if (o.esperarEsfriar && ultimaEm && agora.getTime() - ultimaEm < DEBOUNCE_MS / 2) return { tipo: 'adiada', emMs: Math.max(60_000, DEBOUNCE_MS - (agora.getTime() - ultimaEm)) };

  // 5) mesma conversa e mesmo pedido da última leitura NESTE modo: a resposta seria a mesma. (O seco e o ligado têm marcas separadas: o que
  //    o seco leu não pode impedir a primeira leitura de verdade depois que a chave for ligada.)
  const chaveDaConversa = `${ultimaId}|${candidatos.map((c) => c.def.id).join(',')}`;
  const chaveDaUltimaLeitura = `${seco ? 's' : 'l'}:${unit.id}:${leadId}`;
  if (ultimaLeitura.get(chaveDaUltimaLeitura) === chaveDaConversa) return { tipo: 'pulou', motivo: 'a conversa não mudou desde a última leitura' };
  const marcarComoLida = () => {
    if (ultimaLeitura.size > 20_000) ultimaLeitura.clear();
    ultimaLeitura.set(chaveDaUltimaLeitura, chaveDaConversa);
  };

  // 6) a IA — agora sim os áudios viram texto
  await deps.transcrever(unit, falas, audios);
  const r = await deps.perguntar(unit, montarPedido(candidatos, falas));
  if (!r) return { tipo: 'pulou', motivo: 'a IA não respondeu (sem chave ou fora do ar): nada foi gravado' };
  gastarLeitura(unit.id, leadId, dia); // o teto conta leitura em que a IA RESPONDEU; IA fora do ar não gasta a vaga do cartão
  const sugestoes = lerResposta(r.texto);
  if (!sugestoes) return { tipo: 'pulou', motivo: 'não consegui ler a resposta da IA: nada foi gravado' };
  const { aceitas, recusadas } = validarSugestoes(sugestoes, candidatos, falas);
  const pedidos = candidatos.map((c) => c.def.name.trim());
  const etapa = funis.nomeDe(lead.pipeline_id, lead.status_id)?.status ?? null;

  if (seco) {
    for (const a of aceitas) {
      deps.simular(unit, ID_CAPTURA_SILENCIOSA, {
        leadId,
        acao: 'gravaria',
        alvo: a.candidato.def.name.trim(),
        valor: a.texto,
        deEtapa: etapa,
        motivo: a.trecho ? `paciente: «${a.trecho}»` : 'leitura da conversa inteira (sem frase única que prove)',
      });
    }
    for (const x of recusadas) deps.simular(unit, ID_CAPTURA_SILENCIOSA, { leadId, acao: 'pularia', alvo: x.campo, deEtapa: etapa, motivo: x.motivo });
    marcarComoLida();
    return { tipo: 'leu', seco, pedidos, gravaria: aceitas.map((a) => ({ campo: a.candidato.def.name.trim(), valor: a.texto, trecho: a.trecho })), gravou: [], recusadas, custoUsd: r.custoUsd };
  }

  // 7) ligado: a conversa levou segundos. Relê o cartão e confere TUDO de novo antes de escrever (a SDR pode ter preenchido, o cartão
  //    pode ter mudado de funil, a chave pode ter sido desligada).
  const gravou: Array<{ campo: string; valor: string }> = [];
  if (!aceitas.length) {
    marcarComoLida();
    return { tipo: 'leu', seco, pedidos, gravaria: [], gravou, recusadas, custoUsd: r.custoUsd };
  }
  if (deps.estado(unit.slug) !== 'ligado') return { tipo: 'pulou', motivo: 'a chave foi desligada enquanto a IA lia' };
  const fresco = await kommo.getLead(leadId);
  const foraAgora = porQueNaoCapturar({ lead: fresco, funis });
  if (foraAgora) return { tipo: 'pulou', motivo: `${foraAgora} (ao reler o cartão)` };
  const aindaVazios = new Map(camposDaEtapaVazios({ regras, defs, lead: fresco }).map((c) => [c.def.id, c] as const));
  let falhouAoGravar = false;
  for (const a of aceitas) {
    const c = aindaVazios.get(a.candidato.def.id);
    const nome = a.candidato.def.name.trim();
    if (!c) {
      recusadas.push({ campo: nome, motivo: 'o cartão já tinha valor (ou o campo saiu da etapa) ao reler: não sobrescrevi' });
      continue;
    }
    try {
      await kommo.setLeadCustomFieldValue(leadId, c.def.id, c.def.type as never, a.valor, (c.def.enums ?? []) as never);
      gravou.push({ campo: nome, valor: a.texto });
      logger.info({ unit: unit.slug, leadId, campo: nome }, `${ID_CAPTURA_SILENCIOSA}: campo gravado`);
    } catch (err) {
      falhouAoGravar = true;
      recusadas.push({ campo: nome, motivo: `o Kommo recusou a gravação: ${String(err).slice(0, 120)}` });
      logger.warn({ err: String(err), unit: unit.slug, leadId, campo: nome }, `${ID_CAPTURA_SILENCIOSA}: falha ao gravar o campo`);
    }
  }
  // falha de gravação (Kommo fora do ar) não marca a conversa como lida: o próximo turno pulado tenta de novo
  if (!falhouAoGravar) marcarComoLida();
  if (gravou.length) {
    const linhas = gravou.map((g) => `${g.campo}: ${g.valor.slice(0, 120)}`).join(' · ');
    await kommo
      .addLeadNote(leadId, `A IA leu a conversa e preencheu o que estava vazio — ${linhas}. Nada foi sobrescrito. Troque se estiver errado.`)
      .catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_CAPTURA_SILENCIOSA}: a nota não entrou (os campos gravaram)`));
  }
  return { tipo: 'leu', seco, pedidos, gravaria: [], gravou, recusadas, custoUsd: r.custoUsd };
}

// ─── o agendador: espera a conversa esfriar, uma leitura de cada vez ──────────────────────────────

interface Agendado {
  timer: NodeJS.Timeout;
  adiamentos: number;
}
const agendados = new Map<string, Agendado>();
let filaSerial: Promise<unknown> = Promise.resolve();

const chaveDoAgendamento = (unitId: string, leadId: number) => `${unitId}:${leadId}`;

/** Quantos cartões estão esperando esfriar (para o teste e para o log). */
export function agendadosDaCaptura(): number {
  return agendados.size;
}

export type ResultadoDoAgendamento = 'agendada' | 'desligada' | 'ignorada' | 'cheia';

/**
 * Chamado quando o turno da IA foi PULADO por qualquer motivo. Agenda (ou re-agenda: cada fala nova recomeça a contagem) a leitura
 * silenciosa do cartão para daqui a `DEBOUNCE_MS`. Não lê nada agora, não espera e NUNCA lança. Chave desligada: nem agenda.
 */
export function agendarCapturaSilenciosa(
  args: { unit: UnidadeDoAgendamento; leadId: number; isChatMessage: boolean },
  deps: DepsDaCaptura = depsReais,
  o: { adiamentos?: number; emMs?: number } = {},
): ResultadoDoAgendamento {
  try {
    const leadId = args.leadId;
    // guarda só a identidade: o objeto inteiro do Prisma traz tokens e chaves e ficaria 10 min na memória, por cartão
    const unit: UnidadeDoAgendamento = { id: args.unit.id, slug: args.unit.slug };
    // só mensagem de chat de verdade: webhook de campo/etapa traz texto sintético e não é «o paciente escreveu»
    if (!args.isChatMessage || leadId <= 0) return 'ignorada';
    if (deps.estado(unit.slug) === 'desligado') return 'desligada';
    const chave = chaveDoAgendamento(unit.id, leadId);
    const antigo = agendados.get(chave);
    if (!antigo && agendados.size >= MAX_AGENDADOS) return 'cheia';
    if (antigo) clearTimeout(antigo.timer);
    const adiamentos = o.adiamentos ?? 0;
    const timer = setTimeout(() => {
      agendados.delete(chave);
      filaSerial = filaSerial.then(() => comPrazo(executarAgendada(unit, leadId, deps, adiamentos), PRAZO_DA_LEITURA_MS, unit.slug, leadId));
    }, o.emMs ?? DEBOUNCE_MS);
    timer.unref?.();
    agendados.set(chave, { timer, adiamentos });
    return 'agendada';
  } catch (err) {
    logger.warn({ err: String(err) }, `${ID_CAPTURA_SILENCIOSA}: não consegui agendar (segue)`);
    return 'ignorada';
  }
}

/** Larga a leitura que travou (Kommo, Whisper ou IA pendurados) para a fila andar. A promessa velha segue sozinha e seu erro já é tratado dentro dela. */
function comPrazo(p: Promise<void>, ms: number, slug: string, leadId: number): Promise<void> {
  let t: NodeJS.Timeout | undefined;
  const prazo = new Promise<void>((resolve) => {
    t = setTimeout(() => {
      logger.warn({ unit: slug, leadId, ms }, `${ID_CAPTURA_SILENCIOSA}: a leitura passou do prazo — larguei para a fila andar`);
      resolve();
    }, ms);
    t.unref?.();
  });
  return Promise.race([p, prazo]).finally(() => clearTimeout(t));
}

async function executarAgendada(unitDoTurno: UnidadeDoAgendamento, leadId: number, deps: DepsDaCaptura, adiamentos: number): Promise<void> {
  try {
    // a unidade de agora (token e chave podem ter mudado nos 10 min)
    const unit = await deps.unidade(unitDoTurno);
    if (!unit) return;
    const r = await lerCartaoEmSilencio(unit, leadId, deps, { esperarEsfriar: adiamentos < MAX_ADIAMENTOS });
    if (r.tipo === 'adiada') {
      // alguém falou há pouco (a SDR respondendo): espera esfriar de novo — se um turno novo chegar nesse meio tempo, ele re-agenda por cima
      if (!agendados.has(chaveDoAgendamento(unit.id, leadId))) agendarCapturaSilenciosa({ unit, leadId, isChatMessage: true }, deps, { adiamentos: adiamentos + 1, emMs: r.emMs });
      return;
    }
    if (r.tipo === 'leu') {
      logger.info(
        { unit: unit.slug, leadId, seco: r.seco, pedidos: r.pedidos.length, gravaria: r.gravaria.length, gravou: r.gravou.length, recusadas: r.recusadas.length, custoUsd: Number(r.custoUsd.toFixed(5)) },
        `${ID_CAPTURA_SILENCIOSA}: leitura`,
      );
    } else if (r.tipo === 'pulou') {
      logger.debug({ unit: unit.slug, leadId, motivo: r.motivo }, `${ID_CAPTURA_SILENCIOSA}: pulei`);
    }
  } catch (err) {
    logger.warn({ err: String(err), unit: unitDoTurno.slug, leadId }, `${ID_CAPTURA_SILENCIOSA}: erro na leitura — pulei`);
  }
}

// ─── as dependências de verdade ───────────────────────────────────────────────────────────────────

const cacheFunis = new Map<string, { em: number; funis: Funis | null }>();
const cacheCampos = new Map<string, { em: number; defs: DefinicaoDeCampo[] }>();

async function funisDaConta(unit: Unit, kommo: KommoDaCaptura): Promise<Funis | null> {
  const hit = cacheFunis.get(unit.id);
  if (hit && Date.now() - hit.em < CACHE_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo as KommoClient);
  if (funis) cacheFunis.set(unit.id, { em: Date.now(), funis });
  return funis;
}

async function camposDaConta(unit: Unit, kommo: KommoDaCaptura): Promise<DefinicaoDeCampo[]> {
  const hit = cacheCampos.get(unit.id);
  if (hit && Date.now() - hit.em < CACHE_TTL_MS) return hit.defs;
  const defs = (await (kommo as KommoClient).listarCamposDoCartao()) as DefinicaoDeCampo[];
  cacheCampos.set(unit.id, { em: Date.now(), defs });
  return defs;
}

async function falasDoCartao(unit: Unit, kommo: KommoDaCaptura, lead: KommoLead): Promise<{ falas: Fala[]; ultimaId: string; audios: ReadonlyMap<string, string> }> {
  const { mensagens } = await historicoOficial(kommo as KommoClient, lead.id, MAX_FALAS);
  const primeira = mensagens[0];
  const envios = primeira ? await enviosDaSofia(unit, lead.id, new Date(primeira.em.getTime() - 10 * 60_000), { comCutucada: true }) : [];
  const falas = reclassificarFalas(mensagens, envios, { cartaoComEtiquetaDeRobo: cartaoComEtiquetaDeRobo(lead) });
  const audios = new Map(mensagens.filter((m) => m.anexo?.tipo === 'voice' && m.anexo.link).map((m) => [m.id, m.anexo!.link as string] as const));
  return { falas, ultimaId: mensagens.length ? mensagens[mensagens.length - 1].id : 'vazia', audios };
}

/** id da mensagem → o que o paciente disse no áudio. Conversa relida não paga a mesma transcrição duas vezes. */
const transcricoes = new Map<string, string>();

/** Os áudios MAIS RECENTES do paciente viram texto (a queixa quase sempre vem em áudio); falha de transcrição deixa o «[áudio]». */
async function transcreverOsAudios(unit: Unit, falas: Fala[], audios: ReadonlyMap<string, string>): Promise<void> {
  const pendentes = falas.filter((f) => f.autor === 'paciente' && audios.has(f.id)).slice(-MAX_AUDIOS);
  for (const f of pendentes) {
    let texto = transcricoes.get(f.id);
    if (texto === undefined) {
      const t = await transcribeAudio(unit, audios.get(f.id) as string).catch(() => null);
      if (!t?.text) continue;
      texto = t.text;
      if (transcricoes.size > 5_000) transcricoes.clear();
      transcricoes.set(f.id, texto);
    }
    f.texto = `${f.texto} (áudio) ${texto}`.trim();
  }
}

async function perguntarAoModelo(unit: Unit, user: string, chamar?: Chamar): Promise<{ texto: string; custoUsd: number } | null> {
  const r = await chamarAnthropic(unit, { modelo: MODELO, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS, system: INSTRUCAO, user }, chamar);
  if (r.ok) return { texto: r.texto, custoUsd: calculateCost(MODELO, r.entrada, r.saida) };
  logger.warn({ unit: unit.slug, motivo: r.motivo }, `${ID_CAPTURA_SILENCIOSA}: a IA não leu a conversa — não fiz nada`);
  return null;
}

export const depsReais: DepsDaCaptura = {
  agora: () => new Date(),
  unidade: (ref) => prisma.unit.findUnique({ where: { id: ref.id } }),
  estado: (slug) => estadoDaCapturaSilenciosa(slug),
  kommo: (unit) => createKommoClient(unit),
  regras: (unit) => prisma.leadFieldRule.findMany({ where: { unitId: unit.id, enabled: true } }),
  funis: (unit, kommo) => funisDaConta(unit, kommo),
  campos: (unit, kommo) => camposDaConta(unit, kommo),
  grupo: (unit) => grupoDaUnidade(unit.id),
  falas: falasDoCartao,
  transcrever: transcreverOsAudios,
  perguntar: (unit, user) => perguntarAoModelo(unit, user),
  simular: registrarSimulacao,
};
