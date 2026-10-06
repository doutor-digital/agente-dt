/**
 * O que o cartão precisa dizer depois que a Sofia marca a consulta — além dos carimbos
 * fixos (Agendou, Data da Consulta, Situação…) que moram em `agendar_consulta`.
 *
 * Dois bugs vistos ao vivo em 06/10/2026 (lead de teste 28088906, Açailândia):
 *
 * 1. QUALIFICAÇÃO VAZIA. A IA marcou e "★ Qualificação (Quente/Morno/Frio)" ficou em
 *    branco: ela só grava o campo quando decide chamar a ferramenta da regra, e no turno
 *    em que marca ela está ocupada marcando. Regra do João: quem agenda é QUENTE. Sem
 *    isso o evento Lead do CAPI (n8n) não sai e o alerta "Rastreio Meta · Agendou sem
 *    qualificação" dispara.
 *
 * 2. "¤ PAGAMENTO ANTECIPADO" = SIM PARA QUEM PAGA NO DIA. A ferramenta carimbava Sim
 *    sempre (só o RETORNO PÓS-TRATAMENTO escapava), mesmo com o paciente escolhendo
 *    pagar na clínica. O sinal real já existe: o argumento `formaPagamento` que a
 *    própria `agendar_consulta` exige antes de reservar (`porQueNaoReservar`).
 */
import type { LeadFieldRule, Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { CAMPOS_DIGITAL } from '../services/lead-metrics.service.js';
import type { KommoClient, KommoCustomFieldValue, KommoFieldType, KommoLead } from '../services/kommo.service.js';
import { coergirValor } from './captura-unificada.js';

// ---------------------------------------------------------------------------
// Qualificação
// ---------------------------------------------------------------------------

/** A regra que grava a temperatura do lead (Quente/Morno/Frio) — não a data nem o resultado. */
export function ehRegraDeQualificacao(nomeCampo: string): boolean {
  return /qualifica/i.test(nomeCampo) && !/data|resultado|motivo/i.test(nomeCampo);
}

type Enum = { id: number; value: string };

export interface CampoDeQualificacao {
  id: number;
  nome: string;
  tipo: KommoFieldType;
  enums: Enum[];
  /** De onde veio: a regra da unidade (a mesma que dá a ferramenta à IA) ou o cartão da conta. */
  fonte: 'regra' | 'conta';
}

type RegraMinima = Pick<LeadFieldRule, 'kommoFieldId' | 'kommoFieldName' | 'kommoFieldType' | 'kommoFieldEnums' | 'enabled'>;
type CampoDaConta = { id: number; name: string; type: string; enums?: Enum[] | null };

function enumsDe(bruto: unknown): Enum[] {
  return Array.isArray(bruto)
    ? (bruto as Enum[]).filter((e) => e && typeof e.id === 'number' && typeof e.value === 'string')
    : [];
}

/**
 * O rótulo exato da opção "Quente" do campo. Resolve "Quente 🔥" e afins pelo mesmo
 * casamento da `registrar_campo`. Campo sem opções conhecidas → "Quente" puro (o Kommo
 * aceita o rótulo no PATCH de select). `null` = o campo tem opções e nenhuma é Quente.
 */
export function opcaoQuente(campo: Pick<CampoDeQualificacao, 'nome' | 'tipo' | 'enums'>): string | null {
  if (!campo.enums.length) return 'Quente';
  const r = coergirValor(
    { kommoFieldName: campo.nome, kommoFieldType: campo.tipo, kommoFieldEnums: campo.enums },
    'Quente',
  );
  return r.ok && typeof r.valor === 'string' ? r.valor : null;
}

/**
 * Acha o campo de qualificação por NOME, nunca por id cravado.
 *
 * Primeiro a regra ligada da unidade (`lead_field_rules`) — é o campo em que a IA
 * gravaria pela `registrar_campo`, com as opções daquela conta. Sem regra, o campo do
 * cartão da conta cujo nome é de qualificação. Entre vários candidatos, ganha o que
 * tem a opção Quente.
 */
export function escolherCampoDeQualificacao(
  regras: RegraMinima[],
  camposDaConta: CampoDaConta[],
): CampoDeQualificacao | null {
  const daRegra: CampoDeQualificacao[] = regras
    .filter((r) => r.enabled && ehRegraDeQualificacao(r.kommoFieldName))
    .map((r) => ({
      id: r.kommoFieldId,
      nome: r.kommoFieldName,
      tipo: r.kommoFieldType as KommoFieldType,
      enums: enumsDe(r.kommoFieldEnums),
      fonte: 'regra' as const,
    }));
  const daConta: CampoDeQualificacao[] = camposDaConta
    .filter((c) => (c.type === 'select' || c.type === 'radiobutton') && ehRegraDeQualificacao(c.name))
    .map((c) => ({
      id: c.id,
      nome: c.name,
      tipo: c.type as KommoFieldType,
      enums: enumsDe(c.enums),
      fonte: 'conta' as const,
    }));

  for (const grupo of [daRegra, daConta]) {
    const comQuente = grupo.find((c) => c.enums.length > 0 && opcaoQuente(c) !== null);
    if (comQuente) return comQuente;
    const qualquer = grupo.find((c) => opcaoQuente(c) !== null);
    if (qualquer) return qualquer;
  }
  return null;
}

function primeiroValor(campos: KommoCustomFieldValue[] | null | undefined, fieldId: number): unknown {
  const v = (campos ?? []).find((c) => c.field_id === fieldId)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : v;
}

function normalizar(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** O cartão já está Quente? (Evita um PATCH que não muda nada.) */
export function jaEstaQuente(lead: Pick<KommoLead, 'custom_fields_values'> | null, fieldId: number): boolean {
  const v = primeiroValor(lead?.custom_fields_values, fieldId);
  return typeof v === 'string' && normalizar(v).startsWith('quente');
}

export interface ResultadoQualificacao {
  /** Nome do campo que ficou (ou falhou ao ficar) Quente; null se a conta não tem. */
  campo: string | null;
  gravouQuente: boolean;
  carimbouData: boolean;
  motivo?: string;
}

/**
 * Agendou → Quente. Sobrescreve Morno/Frio/vazio. Carimba "◷ Data da qualificação"
 * só se estiver vazia (a data é de quando qualificou pela primeira vez). Lança se o
 * PATCH falhar — quem chama registra a falha junto com os outros carimbos.
 */
export async function carimbarQuenteAoAgendar(args: {
  unit: Unit;
  kommo: KommoClient;
  leadId: number;
  /** O lead lido antes dos carimbos — para não sobrescrever a data e pular o no-op. */
  lead: KommoLead | null;
}): Promise<ResultadoQualificacao> {
  const { unit, kommo, leadId, lead } = args;

  const regras = await prisma.leadFieldRule.findMany({
    where: { unitId: unit.id, enabled: true },
    select: { kommoFieldId: true, kommoFieldName: true, kommoFieldType: true, kommoFieldEnums: true, enabled: true },
  });
  let campo = escolherCampoDeQualificacao(regras, []);
  if (!campo) campo = escolherCampoDeQualificacao([], await kommo.listLeadCustomFieldsTyped());
  if (!campo) return { campo: null, gravouQuente: false, carimbouData: false, motivo: 'conta sem campo de Qualificação' };

  const rotulo = opcaoQuente(campo);
  if (!rotulo) return { campo: campo.nome, gravouQuente: false, carimbouData: false, motivo: 'campo sem opção Quente' };

  let gravouQuente = false;
  if (!jaEstaQuente(lead, campo.id)) {
    await kommo.setLeadCustomFieldValue(leadId, campo.id, campo.tipo, rotulo, campo.enums);
    gravouQuente = true;
  }

  let carimbouData = false;
  const esquema = await esquemaDaUnidade(unit, kommo);
  const idData = esquema.campoPorNome(CAMPOS_DIGITAL.DATA_QUALIFICACAO);
  if (idData !== null && primeiroValor(lead?.custom_fields_values, idData) === null) {
    await kommo.setLeadCustomFieldValue(leadId, idData, 'date', new Date().toISOString());
    carimbouData = true;
  }

  return { campo: campo.nome, gravouQuente, carimbouData };
}

// ---------------------------------------------------------------------------
// Pagamento antecipado
// ---------------------------------------------------------------------------

export type ValorPagamentoAntecipado = 'Sim' | 'Não';

export interface DecisaoPagamento {
  /** `null` = não mexer no campo (remarcação sem escolha registrada e cartão já preenchido). */
  valor: ValorPagamentoAntecipado | null;
  porque: string;
}

/**
 * O que gravar em "¤ Pagamento antecipado" ao agendar.
 *
 * Este é o campo que vale (decisão do João, 06/10/2026). "Consulta pg no dia" e
 * "✓ Consulta pg antecipado" não são escritos aqui — este último é o que a régua de
 * follow-up e a trava de reserva leem como PROVA de pagamento (`pagouOAntecipado`),
 * e continua intocado.
 *
 * Ordem dos sinais:
 *  1. RETORNO PÓS-TRATAMENTO → Não (regra antiga, mantida).
 *  2. Pagamento comprovado antes de reservar (`spineBookingRequiresPayment`: a
 *     ferramenta só chega aqui com cartão ou comprovante provando) → Sim.
 *  3. A forma que o paciente escolheu — `formaPagamento` da própria chamada, ou, na
 *     remarcação (que não traz a forma), a escolha guardada na conversa:
 *     pix_antecipado → Sim; na_clinica → Não.
 *  4. Sem sinal: se o cartão já tem valor, não mexe (remarcação não apaga o que a
 *     SDR/IA gravou); se está vazio, Não. Errar para Não é o lado seguro: Sim sem
 *     pagamento é o que infla o "pagamento antecipado" do relatório.
 */
export function decidirPagamentoAntecipado(s: {
  ehRetorno: boolean;
  pagamentoComprovado: boolean;
  formaPagamento?: string | null;
  escolhaSalva?: string | null;
  valorAtual?: unknown;
}): DecisaoPagamento {
  if (s.ehRetorno) return { valor: 'Não', porque: 'retorno pós-tratamento' };
  if (s.pagamentoComprovado) return { valor: 'Sim', porque: 'pagamento comprovado antes da reserva' };

  const forma = s.formaPagamento ?? s.escolhaSalva ?? null;
  if (forma === 'pix_antecipado') return { valor: 'Sim', porque: 'paciente escolheu Pix antecipado' };
  if (forma === 'na_clinica') return { valor: 'Não', porque: 'paciente escolheu pagar na clínica' };

  const temValor = s.valorAtual !== undefined && s.valorAtual !== null && String(s.valorAtual).trim() !== '';
  if (temValor) return { valor: null, porque: 'sem escolha registrada; mantém o que já está no cartão' };
  return { valor: 'Não', porque: 'sem sinal de pagamento antecipado' };
}

/** Valor atual de um campo no lead lido — exportado para o teste e para `agendar_consulta`. */
export function valorDoCampo(lead: Pick<KommoLead, 'custom_fields_values'> | null, fieldId: number | null): unknown {
  return fieldId === null ? null : primeiroValor(lead?.custom_fields_values, fieldId);
}
