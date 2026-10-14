/**
 * Ponte 0.5.0 (visual novo) — os campos novos da resposta do cartão (`POST …/ponte/cartao`). Tudo PURO: quem chama
 * (`controllers/ponte.controller.ts`) já leu o cartão, os campos da conta, o grupo de unidades e o contato.
 *
 * O painel novo mostra, sem gastar chamada a mais no Kommo:
 *   - `telefone`             — o número do paciente, do jeito que se lê ("(99) 90000-0001");
 *   - `unidade`              — o selo da UNIDADE: o `⌂ Unidade de atendimento` na conta de duas unidades (Petrópolis +
 *                              Caxias; vazio = "escolha a unidade"), ou o nome da unidade na conta de uma só;
 *   - `qualificacao`         — o ★ Qualificação (Quente/Morno/Frio): `null` = a conta tem o campo e ele está vazio;
 *                              `undefined` (fica fora do JSON) = a conta não tem o campo;
 *   - `naEtapaDesde`         — desde quando o cartão está na etapa (o mesmo do resumo);
 *   - `barraTratamento`      — a trilha do funil TRATAMENTO, só com o cartão nele;
 *   - `sofiaNaUnidade`       — a unidade tem a Sofia (chave do modelo + caminho de entrega)? Sem ela, o painel esconde
 *                              o estado da Sofia e a pausa;
 *   - `franquiaAndaSozinha`  — "A franquia move a etapa" E o "Sincronizador da franquia" estão LIGADOS (tela de
 *                              Automações, `unit_automacoes`, ou o `.env` de sempre) para a unidade DO CARTÃO? Sem os
 *                              dois, o painel não promete que o cartão anda sozinho: "a recepção atualiza pela franquia".
 */
import type { Unit } from '@prisma/client';
import { automacaoLigada } from './automacoes-estado.js';
import type { GrupoDoCrm } from './crm-compartilhado.js';
import { normalizar } from './franquia-sync.js';
import { normalizarNome } from './kommo-schema.js';
import { barraDoFunil, type EtapaDaBarra } from './ponte-cartao.js';
import { telefoneParaMostrar, type CampoDoCartao } from './ponte-fila.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';

export interface UnidadeDoPainel {
  /** O que o selo mostra. `null` só na conta de duas unidades com o campo vazio. */
  nome: string | null;
  /** A conta do Kommo atende mais de uma unidade (o campo manda). */
  compartilhada: boolean;
  /** As unidades da conta dividida, para o painel separar as respostas prontas de cada uma. */
  opcoes?: string[];
}

/**
 * O nome curto da unidade para o selo: "Doutor Hérnia Açailândia" → "Açailândia". Nome que não diz a cidade (a de
 * Imperatriz se chama "Comercial" no banco) cai no slug: "doutor-hernia-imperatriz" → "Imperatriz".
 */
export function nomeCurtoDaUnidade(nome: string | null | undefined, slug: string): string {
  const curto = String(nome ?? '').replace(/^\s*doutor\s+h[eé]rnia\s*[-–·:]?\s*/i, '').trim();
  if (curto && !['comercial', 'unidade', 'clinica'].includes(normalizar(curto))) return curto;
  return slug
    .replace(/^doutor-hernia-/, '')
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

/**
 * O selo da unidade. Conta de uma unidade só: o nome dela. Conta dividida: o valor do campo — com o rótulo do grupo
 * quando bate (a grafia certa), ou o próprio valor quando ninguém do grupo usa (o painel mostra o que o cartão diz).
 */
export function unidadeDoPainel(grupo: GrupoDoCrm | null, nomeDaUnidade: string, valorNoCartao: string | null): UnidadeDoPainel {
  if (!grupo) return { nome: nomeDaUnidade, compartilhada: false };
  const opcoes = grupo.membros.map((m) => m.rotulo);
  if (!valorNoCartao) return { nome: null, compartilhada: true, opcoes };
  const dono = grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valorNoCartao));
  return { nome: dono ? dono.rotulo : valorNoCartao, compartilhada: true, opcoes };
}

/**
 * O slug da unidade DONA do cartão — é a automação DELA que vale. Conta de uma unidade só: a própria. Conta dividida:
 * a do rótulo no campo; campo vazio (ou valor que ninguém usa) = `null`: nenhuma automação mexe nesse cartão.
 */
export function slugDaUnidadeDoCartao(grupo: GrupoDoCrm | null, unit: Pick<Unit, 'id' | 'slug'>, valorNoCartao: string | null): string | null {
  if (!grupo) return unit.slug;
  if (!valorNoCartao) return null;
  const dono = grupo.membros.find((m) => normalizar(m.rotulo) === normalizar(valorNoCartao));
  if (!dono) return null;
  return dono.slug ?? (dono.unitId === unit.id ? unit.slug : null);
}

/**
 * O cartão anda sozinho atrás da franquia nesta unidade? Precisa das DUAS automações ligadas: a que move a etapa e a que
 * copia a franquia para o cartão (data da consulta, sessões…). "Só no papel" (seco) não conta — nada se move de verdade.
 */
export function franquiaAndaSozinha(slug: string | null, ambiente: NodeJS.ProcessEnv = process.env): boolean {
  if (!slug) return false;
  return automacaoLigada(slug, 'franquia-move', ambiente.FRANQUIA_MOVE_SLUGS) && automacaoLigada(slug, 'franquia-sync', ambiente.FRANQUIA_SYNC_SLUGS);
}

/** Um campo do cartão como o Kommo devolve (`custom_fields_values`): com o id, que casa com a definição da conta. */
type CampoComId = CampoDoCartao & { field_id?: number };

/** O campo de qualificação da conta: o nome começa com "Qualificação" (o ★ e os parênteses não contam). Cabeçalho não. */
function ehQualificacao(nome: string | null | undefined): boolean {
  const n = String(nome ?? '').trim();
  if (!n || n.startsWith('##') || n.startsWith('*')) return false;
  return normalizarNome(n).startsWith('qualificacao');
}

/**
 * O ★ Qualificação do cartão. Com os campos da conta: `undefined` se a conta não tem o campo; `null` se tem e está vazio;
 * o texto da opção (Quente/Morno/Frio) se preenchido. Sem os campos da conta (o Kommo não respondeu): o valor do
 * cartão, ou `undefined` (não dá para saber se o campo existe — o painel só não mostra).
 */
export function qualificacaoDoCartao(defs: ReadonlyArray<DefinicaoDeCampo>, campos: ReadonlyArray<CampoComId> | null | undefined): string | null | undefined {
  const lista = campos ?? [];
  const valorDe = (c: CampoComId | undefined): string | null => {
    const v = c?.values?.[0]?.value;
    return v == null || typeof v === 'object' || String(v).trim() === '' ? null : String(v).trim().slice(0, 40);
  };
  if (!defs.length) {
    const c = lista.find((f) => ehQualificacao(f.field_name));
    return c ? valorDe(c) ?? undefined : undefined;
  }
  const def = defs.find((d) => ehQualificacao(d.name));
  if (!def) return undefined;
  return valorDe(lista.find((f) => f.field_id === def.id));
}

/**
 * O telefone para mostrar: o primeiro candidato com 10 a 13 dígitos (o do contato do Kommo, depois o da conversa).
 * Sem o 55 na frente (10 ou 11 dígitos), põe. `null` se nenhum serve.
 */
export function telefoneDoPainel(...candidatos: Array<string | null | undefined>): string | null {
  for (const c of candidatos) {
    let d = String(c ?? '').replace(/\D+/g, '');
    if (d.length === 10 || d.length === 11) d = '55' + d;
    if (d.length >= 12 && d.length <= 13) return telefoneParaMostrar(d);
  }
  return null;
}

/**
 * A unidade tem a Sofia? Precisa de um jeito de ENTREGAR a resposta (o campo "Resposta IA", o modo widget ou o envio
 * direto) e da chave do modelo do provedor dela. Unidade desativada: não. É a mesma conta do diagnóstico do console
 * (`checarUnidades`), com os outros dois caminhos de entrega — esconder a pausa de quem tem a Sofia seria pior do que
 * mostrar a de quem não tem.
 */
export function sofiaNaUnidade(
  unit: Pick<Unit, 'isActive' | 'llmProvider' | 'anthropicApiKey' | 'googleApiKey' | 'openaiApiKey' | 'kommoReplyFieldId' | 'kommoWidgetReplyEnabled' | 'kommoBypassSalesbot'>,
  chaveOpenAiDoAmbiente: string | undefined = process.env.OPENAI_API_KEY,
): boolean {
  if (unit.isActive === false) return false;
  const entrega = !!unit.kommoReplyFieldId || !!unit.kommoWidgetReplyEnabled || !!unit.kommoBypassSalesbot;
  const p = String(unit.llmProvider ?? '').toLowerCase();
  const modelo =
    p === 'anthropic' ? !!unit.anthropicApiKey
      : p === 'google' ? !!unit.googleApiKey
        : p === 'openai' ? !!(unit.openaiApiKey || chaveOpenAiDoAmbiente)
          : !!(unit.anthropicApiKey || unit.googleApiKey || unit.openaiApiKey);
  return entrega && modelo;
}

/** O funil TRATAMENTO da conta (pelo nome), fora os arquivados. */
export function funilTratamento<T extends { name: string; is_archive?: boolean }>(funis: T[]): T | null {
  return funis.find((f) => !f.is_archive && normalizar(f.name) === 'tratamento') ?? null;
}

/** A trilha do TRATAMENTO (EM TRATAMENTO → ALTA, e TRATAMENTO CANCELADO) — só quando o cartão está nesse funil. */
export function barraDoTratamento(
  funis: Array<{ id: number; name: string; is_archive?: boolean; statuses: Array<{ id: number; name: string; sort?: number; type?: number }> }>,
  lead: { pipeline_id: number; status_id: number },
): { funil: string; noFunil: true; etapas: EtapaDaBarra[] } | null {
  const t = funilTratamento(funis);
  if (!t || t.id !== lead.pipeline_id) return null;
  return { funil: t.name, noFunil: true, etapas: barraDoFunil(t, lead) };
}

/** Epoch (s) da entrada na etapa → ISO. `null` se não há. */
export function desdeEmIso(epochS: number | null | undefined): string | null {
  return typeof epochS === 'number' && Number.isFinite(epochS) && epochS > 0 ? new Date(epochS * 1000).toISOString() : null;
}
