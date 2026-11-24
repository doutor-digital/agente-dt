/**
 * Instala, numa unidade, as `lead_field_rules` de outra unidade-modelo (Timbó), resolvendo o campo PELO NOME na conta de destino.
 *
 * Por que existe (24/11/2026): Salto e Tatuí tinham ZERO regras de captura. Sem regra a Sofia não recebe a ferramenta de gravar
 * (Queixa, Qualificação, Região da dor... 0 gravações em 14 dias, 5.110 ações no Kommo só em Salto) e o `backfill-campos` sai com
 * "sem regras de conversa — pulando". Id de campo é POR CONTA: copiar o id do Timbó apontou 19 unidades para o campo de outra
 * clínica (22/09). Por isso aqui o que vem do modelo é só o TEXTO (instrução, formato, exemplos); id, tipo e opções vêm da conta.
 *
 * Regras que esta decisão segue:
 *  - nome que não existe na conta: fica de fora e é listado (nunca cria campo, nunca chuta outro);
 *  - nome que casa com MAIS DE UM campo da conta: fica de fora (escolher o primeiro é palpite de identidade);
 *  - tipo incompatível (modelo "select", conta "texto"): fica de fora;
 *  - lista sem opções na conta: fica de fora (a regra pediria um valor que não existe);
 *  - já existe regra da unidade com o mesmo `toolName` OU para o mesmo campo: não duplica.
 */
import type { LeadFieldRuleInput } from '../services/lead-field-rules.service.js';
import { SUPPORTED_FIELD_TYPES, type KommoFieldType } from '../services/kommo.service.js';
import { normalizar } from './franquia-sync.js';

export interface ModeloDeRegra {
  kommoFieldName: string;
  kommoFieldType: string;
  toolName: string;
  instruction: string;
  valueHint?: string | null;
  examples?: string[] | null;
  updatesLeadTitle?: boolean | null;
  /** as opções da regra NO MODELO, para avisar quando a conta de destino tem outras */
  kommoFieldEnums?: unknown;
}

export interface CampoDaConta {
  id: number;
  name: string;
  type: string;
  enums: Array<{ id: number; value: string }>;
}

export interface RegraExistente {
  toolName: string;
  kommoFieldId: number;
}

export type MotivoDeFora = 'não existe na conta' | 'mais de um campo com esse nome' | 'tipo incompatível' | 'tipo sem suporte' | 'lista sem opções na conta';

export interface PlanoDeRegras {
  criar: LeadFieldRuleInput[];
  jaExistem: Array<{ nome: string; porque: 'mesma ferramenta' | 'mesmo campo' }>;
  deFora: Array<{ nome: string; motivo: MotivoDeFora; detalhe?: string }>;
  /**
   * Lista cujas opções NO MODELO não existem na conta: a instrução (copiada do modelo) pode pedir um valor que a conta recusa.
   * A regra É criada; o aviso é para quem aprova conferir. `soNoModelo` = opções do modelo que a conta não tem.
   */
  avisos: Array<{ nome: string; soNoModelo: string[]; naConta: string[] }>;
}

const LISTAS = new Set(['select', 'multiselect', 'radiobutton']);
const TEXTOS = new Set(['text', 'textarea']);
const NUMEROS = new Set(['numeric', 'monetary']);
const DATAS = new Set(['date', 'birthday']);

/** Mesma família de tipo: texto com texto, lista com lista, número com número, data com data. */
export function tiposCompativeis(modelo: string, conta: string): boolean {
  if (modelo === conta) return true;
  return [LISTAS, TEXTOS, NUMEROS, DATAS].some((g) => g.has(modelo) && g.has(conta));
}

/** O campo da conta pelo nome do modelo: nome exato primeiro; depois o normalizado (tira símbolo, acento, caixa). */
export function acharCampoPorNome(
  campos: ReadonlyArray<CampoDaConta>,
  nome: string,
): { campo: CampoDaConta } | { ausente: true } | { ambiguo: CampoDaConta[] } {
  const exatos = campos.filter((c) => c.name.trim().toLowerCase() === nome.trim().toLowerCase());
  if (exatos.length === 1) return { campo: exatos[0]! };
  if (exatos.length > 1) return { ambiguo: exatos };
  const alvo = normalizar(nome);
  if (!alvo) return { ausente: true };
  const parecidos = campos.filter((c) => normalizar(c.name) === alvo);
  if (parecidos.length === 1) return { campo: parecidos[0]! };
  if (parecidos.length > 1) return { ambiguo: parecidos };
  return { ausente: true };
}

export function planejarRegras(
  modelo: ReadonlyArray<ModeloDeRegra>,
  campos: ReadonlyArray<CampoDaConta>,
  existentes: ReadonlyArray<RegraExistente>,
): PlanoDeRegras {
  const plano: PlanoDeRegras = { criar: [], jaExistem: [], deFora: [], avisos: [] };
  const toolsUsadas = new Set(existentes.map((e) => e.toolName));
  const camposUsados = new Set(existentes.map((e) => e.kommoFieldId));

  for (const m of modelo) {
    const achado = acharCampoPorNome(campos, m.kommoFieldName);
    if ('ausente' in achado) {
      plano.deFora.push({ nome: m.kommoFieldName, motivo: 'não existe na conta' });
      continue;
    }
    if ('ambiguo' in achado) {
      plano.deFora.push({ nome: m.kommoFieldName, motivo: 'mais de um campo com esse nome', detalhe: achado.ambiguo.map((c) => `${c.id}:${c.name}`).join(', ') });
      continue;
    }
    const campo = achado.campo;
    if (!SUPPORTED_FIELD_TYPES.has(campo.type)) {
      plano.deFora.push({ nome: m.kommoFieldName, motivo: 'tipo sem suporte', detalhe: campo.type });
      continue;
    }
    if (!tiposCompativeis(m.kommoFieldType, campo.type)) {
      plano.deFora.push({ nome: m.kommoFieldName, motivo: 'tipo incompatível', detalhe: `modelo ${m.kommoFieldType}, conta ${campo.type}` });
      continue;
    }
    const opcoes = (campo.enums ?? []).filter((e) => e.value);
    if (LISTAS.has(campo.type) && opcoes.length === 0) {
      plano.deFora.push({ nome: m.kommoFieldName, motivo: 'lista sem opções na conta' });
      continue;
    }
    if (toolsUsadas.has(m.toolName)) {
      plano.jaExistem.push({ nome: m.kommoFieldName, porque: 'mesma ferramenta' });
      continue;
    }
    if (camposUsados.has(campo.id)) {
      plano.jaExistem.push({ nome: m.kommoFieldName, porque: 'mesmo campo' });
      continue;
    }
    if (LISTAS.has(campo.type)) {
      const doModelo = ((m.kommoFieldEnums as Array<{ value?: string }> | null | undefined) ?? []).map((e) => e?.value).filter((v): v is string => !!v);
      const daConta = new Set(opcoes.map((e) => normalizar(e.value)));
      const soNoModelo = doModelo.filter((v) => !daConta.has(normalizar(v)));
      if (soNoModelo.length > 0) plano.avisos.push({ nome: campo.name, soNoModelo, naConta: opcoes.map((e) => e.value) });
    }
    // também vale dentro da mesma rodada: dois modelos para o mesmo campo da conta não viram duas regras
    toolsUsadas.add(m.toolName);
    camposUsados.add(campo.id);
    plano.criar.push({
      kommoFieldId: campo.id,
      kommoFieldName: campo.name,
      kommoFieldType: campo.type as KommoFieldType,
      kommoFieldEnums: LISTAS.has(campo.type) ? opcoes.map((e) => ({ id: e.id, value: e.value })) : null,
      toolName: m.toolName,
      instruction: m.instruction,
      valueHint: m.valueHint ?? null,
      examples: m.examples ?? [],
      enabled: true,
      updatesLeadTitle: m.updatesLeadTitle ?? false,
    });
  }
  return plano;
}
